import test from 'node:test'
import { runUrlInstallAcceptance } from './url-install.mjs'

test('prepared Doom installs through real HTTPS in patched Hibi, plays, and releases its sessions', {
  timeout: 900000,
}, async () => {
  await runUrlInstallAcceptance()
})
