/* eslint-env browser */

import * as Y from 'yjs'
import { AblyProvider } from '../src/y-ably.js'

const ydoc = new Y.Doc()
const provider = new AblyProvider('testroom', ydoc)
const yarray = ydoc.getArray()

provider.on('synced', synced => {
  console.log('synced!', synced)
})

yarray.observeDeep(() => {
  console.log('yarray updated: ', yarray.toJSON())
})

// @ts-ignore
window.example = { provider, ydoc, yarray }
