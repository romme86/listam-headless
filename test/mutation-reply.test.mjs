import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMutationReply } from '../src/service.mjs'

test('mutation reply requires an explicit ok true acknowledgement', () => {
    assert.deepEqual(parseMutationReply('{"ok":true}'), { ok: true, reason: null })
    assert.equal(parseMutationReply('{"ok":false,"reason":"not-writable"}').ok, false)
    assert.equal(parseMutationReply(null).ok, false)
    assert.equal(parseMutationReply('{}').ok, false)
    assert.equal(parseMutationReply('not json').ok, false)
})
