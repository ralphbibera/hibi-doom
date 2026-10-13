#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Rebuild Doom and its selected WASI libraries from the delivered source."""
import argparse
import base64
import hashlib
import io
import json
import pathlib
import re
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sdk', type=pathlib.Path, required=True)
parser.add_argument('--work', type=pathlib.Path, required=True)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
work = args.work.resolve()
sdk = args.sdk.resolve()
work.mkdir(parents=True, exist_ok=True)
inventory = json.loads((root / 'engine/upstream-inventory.json').read_text())
source_root = work / 'sources'
source_root.mkdir(exist_ok=True)
if (root / 'engine/vendor').is_dir():
    sources = {name: (root / 'engine' / name).read_bytes() for name in inventory['files']}
else:
    encoded = json.loads((root / 'engine/upstream.json').read_text())
    archive_bytes = base64.b64decode(encoded['base64'], validate=True)
    if len(archive_bytes) != inventory['bytes'] or hashlib.sha256(archive_bytes).hexdigest() != inventory['sha256']:
        raise ValueError('Pinned upstream source archive does not match its inventory.')
    sources = {}
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
        for entry in archive:
            if not entry.isfile() or entry.name not in inventory['files']:
                raise ValueError('Unexpected upstream source archive entry.')
            sources[entry.name] = archive.extractfile(entry).read()
if set(sources) != set(inventory['files']):
    raise ValueError('Upstream source inventory is incomplete.')
for name, contents in sorted(sources.items()):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or hashlib.sha256(contents).hexdigest() != inventory['files'][name]:
        raise ValueError('Invalid upstream source input: ' + name)
    destination = source_root / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(contents)
    destination.chmod(0o755 if name.endswith('.sh') else inventory['modes'][name])
(source_root / 'platform.c').write_bytes((root / 'engine/platform.c').read_bytes())
source_overlays = []
for original, owned in [('i_video.c', 'video.c'), ('i_sound.c', 'audio.c')]:
    path = 'vendor/doomgeneric/doomgeneric/' + original
    contents = (root / 'engine' / owned).read_bytes()
    (source_root / path).write_bytes(contents)
    source_overlays.append({'path': path, 'source': 'engine/' + owned,
                            'sourceSha256': hashlib.sha256(contents).hexdigest(),
                            'sha256': hashlib.sha256(contents).hexdigest(),
                            'originalSha256': inventory['files'][path],
                            'license': 'GPL-2.0-or-later AND GPL-3.0-only',
                            'provenance': 'Indexed adapter derived from pinned i_video.c' if original == 'i_video.c'
                                          else 'Direct host sound backend preserving pinned I_* interface'})
input_patch = (root / 'engine/input.patch').read_bytes()
subprocess.run(['patch', '--batch', '--forward', '-p0'], input=input_patch,
               cwd=source_root, check=True)
input_path = 'vendor/doomgeneric/doomgeneric/g_game.c'
source_overlays.append({'path': input_path, 'source': 'engine/input.patch',
                        'sourceSha256': hashlib.sha256(input_patch).hexdigest(),
                        'sha256': hashlib.sha256((source_root / input_path).read_bytes()).hexdigest(),
                        'originalSha256': inventory['files'][input_path],
                        'license': 'GPL-2.0-or-later AND GPL-3.0-only',
                        'provenance': 'Bounded additive motion patch to pinned G_Responder'})
header_overlays = []
for name in ['doomgeneric.h', 'config.h']:
    header_path = 'vendor/doomgeneric/doomgeneric/' + name
    owned_source = 'engine/' + name
    header_bytes = (root / owned_source).read_bytes()
    (source_root / header_path).write_bytes(header_bytes)
    header_overlays.append({'path': header_path, 'source': owned_source,
                            'sha256': hashlib.sha256(header_bytes).hexdigest(),
                            'originalSha256': inventory['files'][header_path],
                            'license': 'GPL-3.0-only',
                            'provenance': 'Project-owned interface' if name == 'doomgeneric.h'
                                          else 'Project-owned required feature and package constants'})
clang = str(sdk / 'bin/clang')
ar = str(sdk / 'bin/llvm-ar')
nm = str(sdk / 'bin/llvm-nm')
version = subprocess.check_output([clang, '--version'], text=True)
if '20.1.8-wasi-sdk' not in version:
    raise ValueError('Use the pinned WASI SDK 27.0 Clang 20.1.8 compiler.')
runtime = work / 'runtime'
runtime.mkdir(exist_ok=True)

def run(command, cwd=source_root):
    with (work / 'build.log').open('a') as log:
        result = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        print('\n'.join((work / 'build.log').read_text().splitlines()[-30:]))
        raise subprocess.CalledProcessError(result.returncode, command)

run([clang, '--target=wasm32-wasi', '-mcpu=lime1', '-O2',
     '-ffile-prefix-map=' + str(source_root) + '=.', '-c',
     'vendor/llvm-project/compiler-rt/lib/builtins/multi3.c',
     '-o', str(runtime / 'multi3.c.obj')])
run([ar, 'rcs', str(runtime / 'libclang_rt.selected.a'), str(runtime / 'multi3.c.obj')])
run(['make', '-j4', '-C', 'vendor/wasi-libc', 'CC=' + clang, 'AR=' + ar, 'NM=' + nm,
     'SYSROOT=' + str(runtime / 'sysroot'), 'TARGET_TRIPLE=wasm32-wasi',
     'EXTRA_CFLAGS=-mcpu=lime1 -O2 -ffile-prefix-map=' + str(source_root) + '=.',
     'BUILTINS_LIB=' + str(runtime / 'libclang_rt.selected.a'), 'default'])
doom = pathlib.PurePosixPath('vendor/doomgeneric/doomgeneric')
match = re.search(r'^SRC_DOOM = (.*)$', (source_root / doom / 'Makefile').read_text(), re.M)
if match is None:
    raise ValueError('Pinned Doom Makefile has no source list.')
excluded_objects = {'doomgeneric_xlib.o', 'dummy.o', 'doomgeneric.o'}
if not excluded_objects.issubset(match[1].split()):
    raise ValueError('The pinned Doom source list changed.')
c_files = [str(doom / (name[:-2] + '.c')) for name in match[1].split() if name not in excluded_objects]
output = work / 'doom.wasm'
compile_flags = [clang, '--target=wasm32-wasi', '-O2', '-fwrapv',
           '-fno-strict-aliasing', '-DNORMALUNIX', '-DLINUX', '-D_DEFAULT_SOURCE',
           '-Wno-implicit-function-declaration', '-Wno-incompatible-pointer-types',
           '-ffile-prefix-map=' + str(source_root) + '=.', '-I', str(doom)]
with (work / 'headers.d').open('w') as dependencies:
    subprocess.run([*compile_flags, '--sysroot=' + str(runtime / 'sysroot'),
                    '-M', '-MT', 'hibi-doom', *c_files, 'platform.c'],
                   cwd=source_root, stdout=dependencies, stderr=subprocess.STDOUT, check=True)
dependency_text = (work / 'headers.d').read_text().replace('\\\n', ' ')
dependency_paths = sorted(set(dependency_text.split()) - {'hibi-doom:'})
dependency_record = {}
for path in dependency_paths:
    candidate = pathlib.Path(path)
    if not candidate.is_absolute():
        candidate = source_root / candidate
    if candidate.is_relative_to(source_root):
        dependency_record[str(candidate.relative_to(source_root))] = hashlib.sha256(candidate.read_bytes()).hexdigest()
for overlay in header_overlays:
    if dependency_record.get(overlay['path']) != overlay['sha256']:
        raise ValueError('Owned header overlay was not used by the compiler.')
command = [*compile_flags, '-mexec-model=reactor',
           *c_files, 'platform.c', '-lm', '--sysroot=' + str(runtime / 'sysroot'),
           '-nodefaultlibs', '-lc', str(runtime / 'libclang_rt.selected.a'),
           '-Wl,--initial-memory=33554432', '-Wl,--max-memory=33554432',
           '-Wl,-z,stack-size=1048576', '-Wl,--export=doom_init', '-Wl,--export=doom_tick',
           '-Wl,--export=doom_key', '-Wl,--export=doom_snapshot',
           '-Wl,--export=doom_mouse', '-Wl,--export=doom_mouse_reset',
           '-Wl,-Map=' + str(work / 'doom.map'), '-o', str(output)]
run(command)
mapping = (work / 'doom.map').read_text()
archives = []
for filename in ['libc.a', 'libclang_rt.selected.a']:
    members = sorted(set(re.findall(re.escape(filename) + r'\(([^)]+)\)', mapping)))
    path = runtime / 'sysroot/lib/wasm32-wasi/libc.a' if filename == 'libc.a' else runtime / filename
    archives.append({'archive': filename, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'members': members})
if archives[1]['members'] != ['multi3.c.obj'] or len(archives[0]['members']) != 86:
    raise ValueError('The linked runtime inventory changed.')
record = {'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
          'compiler': version, 'arguments': command, 'linked': archives,
          'reactor': hashlib.sha256((runtime / 'sysroot/lib/wasm32-wasi/crt1-reactor.o').read_bytes()).hexdigest(),
          'platformSha256': hashlib.sha256((root / 'engine/platform.c').read_bytes()).hexdigest(),
          'compiledSources': {name: hashlib.sha256((source_root / name).read_bytes()).hexdigest()
                              for name in [*c_files, 'platform.c']},
          'headerOverlays': header_overlays,
          'sourceOverlays': source_overlays,
          'compilerDependencies': dependency_record,
          'excludedSources': [str(doom / name) for name in ['dummy.c', 'doomgeneric.c']]}
(work / 'build.json').write_text(json.dumps(record, indent=2) + '\n')
linked_record = {'schema': 1, 'engineSha256': record['sha256'],
                 **{key: record[key] for key in ['platformSha256', 'linked', 'reactor',
                                                'compiledSources', 'headerOverlays', 'sourceOverlays', 'compilerDependencies', 'excludedSources']}}
(work / 'linked.json').write_text(json.dumps(linked_record, indent=2) + '\n')
print(json.dumps({'engine': str(output), 'bytes': record['bytes'], 'sha256': record['sha256']}))
