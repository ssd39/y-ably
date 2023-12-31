import * as error from 'lib0/error'
import * as random from 'lib0/random'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { Observable } from 'lib0/observable'
import * as logging from 'lib0/logging'
import * as promise from 'lib0/promise'
import * as bc from 'lib0/broadcastchannel'
import { createMutex } from 'lib0/mutex'

import * as Y from "yjs"; // eslint-disable-line

import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

import * as cryptoutils from './crypto.js'

import * as Ably from 'ably/promises.js'

const log = logging.createModuleLogger('y-ably')

const messageSync = 0
const messageQueryAwareness = 3
const messageAwareness = 1
const messageBcPeerId = 4

/**
 * @type {Map<string,Room>}
 */
const rooms = new Map()

/**
 * @param {Room} room
 */
const checkIsSynced = (room) => {
  let synced = true
  room.roomPeers.forEach((isSynced) => {
    if (!isSynced) {
      synced = false
    }
  })
  if ((!synced && room.synced) || (synced && !room.synced)) {
    room.synced = synced
    room.provider.emit('synced', [{ synced }])
    log('synced ', logging.BOLD, room.name, logging.UNBOLD, ' with all peers')
  }
}

/**
 * @param {Room} room
 * @param {Uint8Array} buf
 * @param {function} syncedCallback
 * @return {encoding.Encoder?}
 */
const readMessage = (room, buf, syncedCallback) => {
  const decoder = decoding.createDecoder(buf)
  const encoder = encoding.createEncoder()
  const messageType = decoding.readVarUint(decoder)
  if (room === undefined) {
    return null
  }
  const awareness = room.awareness
  const doc = room.doc
  let sendReply = false
  switch (messageType) {
    case messageSync: {
      encoding.writeVarUint(encoder, messageSync)
      const syncMessageType = syncProtocol.readSyncMessage(
        decoder,
        encoder,
        doc,
        room
      )
      if (
        syncMessageType === syncProtocol.messageYjsSyncStep2 &&
        !room.synced
      ) {
        syncedCallback()
      }
      if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
        sendReply = true
      }
      break
    }
    case messageQueryAwareness:
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          awareness,
          Array.from(awareness.getStates().keys())
        )
      )
      sendReply = true
      break
    case messageAwareness:
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        room
      )
      break
    case messageBcPeerId: {
      const add = decoding.readUint8(decoder) === 1
      const peerName = decoding.readVarString(decoder)
      if (
        peerName !== room.peerId &&
        ((room.bcConns.has(peerName) && !add) ||
          (!room.bcConns.has(peerName) && add))
      ) {
        const removed = []
        const added = []
        if (add) {
          room.bcConns.add(peerName)
          added.push(peerName)
        } else {
          room.bcConns.delete(peerName)
          removed.push(peerName)
        }
        broadcastBcPeerId(room)
      }
      break
    }
    default:
      console.error('Unable to compute message')
      return encoder
  }
  if (!sendReply) {
    // nothing has been written, no answer created
    return null
  }
  return encoder
}

/**
 * @param {Room} room
 */
const initialSync = (room) => {
  const provider = room.provider
  const doc = provider.doc
  const awareness = room.awareness
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  room.channel.publish('docUpdated', encoding.toUint8Array(encoder))
  const awarenessStates = awareness.getStates()
  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        awareness,
        Array.from(awarenessStates.keys())
      )
    )
    room.channel.publish('docUpdated', encoding.toUint8Array(encoder))
  }
}

/**
 * @param {Room} room
 * @param {String} clientId
 * @param {Uint8Array} buf
 * @return {encoding.Encoder?}
 */
const readPeerMessage = (room, clientId, buf) => {
  console.log('reading peer meesage')
  log(
    'received message from ',
    logging.BOLD,
    clientId,
    logging.GREY,
    ' (',
    room.name,
    ')',
    logging.UNBOLD,
    logging.UNCOLOR
  )
  return readMessage(room, buf, () => {
    console.log('synced')
    room.roomPeers.set(clientId, true)
    log(
      'synced ',
      logging.BOLD,
      room.name,
      logging.UNBOLD,
      ' with ',
      logging.BOLD,
      clientId
    )
    checkIsSynced(room)
  })
}

/**
 * @param {Room} room
 * @param {Uint8Array} m
 */
const broadcastAblyChannel = (room, m) => {
  log('broadcast message in ', logging.BOLD, room.name, logging.UNBOLD)
  if(room.channel){
    room.channel.publish('docUpdated', m)
  }
  /*room.roomPeers.forEach((_, clientID) => {
    try {
      room.channel.publish(clientID, m)
    } catch (e) {
      console.error(e)
    }
  })*/
}

/**
 * @param {Room} room
 * @param {Uint8Array} m
 */
const broadcastBcMessage = (room, m) =>
  cryptoutils
    .encrypt(m, room.key)
    .then((data) => room.mux(() => bc.publish(room.name, data)))

/**
 * @param {Room} room
 * @param {Uint8Array} m
 */
const broadcastRoomMessage = (room, m) => {
  if (room.bcconnected) {
    broadcastBcMessage(room, m)
  }
  broadcastAblyChannel(room, m)
}

/**
 * @param {Room} room
 */
const broadcastBcPeerId = (room) => {
  if (room.provider.filterBcConns) {
    // broadcast peerId via broadcastchannel
    const encoderPeerIdBc = encoding.createEncoder()
    encoding.writeVarUint(encoderPeerIdBc, messageBcPeerId)
    encoding.writeUint8(encoderPeerIdBc, 1)
    encoding.writeVarString(encoderPeerIdBc, room.peerId)
    broadcastBcMessage(room, encoding.toUint8Array(encoderPeerIdBc))
  }
}

export class Room {
  /**
   * @param {Y.Doc} doc
   * @param {AblyProvider} provider
   * @param {string} name
   * @param {CryptoKey|null} key
   */
  constructor (doc, provider, name, key) {
    /**
     * @type {Ably.Types.RealtimeChannelPromise}
     */
    this.channel = null

    this.ably = null
    /**
     * Do not assume that peerId is unique. This is only meant for sending signaling messages.
     *
     * @type {string}
     */

    this.peerId = random.uuidv4()
    this.doc = doc
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = provider.awareness
    this.provider = provider
    this.synced = false
    this.name = name
    // @todo make key secret by scoping
    this.key = key
    /**
     * @type {Map<string, Boolean>}
     */
    this.roomPeers = new Map()
    /**
     * @type {Set<string>}
     */
    this.bcConns = new Set()
    this.mux = createMutex()
    this.bcconnected = false
    /**
     * @param {ArrayBuffer} data
     */
    this._bcSubscriber = (data) =>
      cryptoutils.decrypt(new Uint8Array(data), key).then((m) =>
        this.mux(() => {
          const reply = readMessage(this, m, () => {})
          if (reply) {
            broadcastBcMessage(this, encoding.toUint8Array(reply))
          }
        })
      )
    /**
     * Listens to Yjs updates and sends them to remote peers
     *
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._docUpdateHandler = (update, origin) => {
      console.log(origin)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      broadcastRoomMessage(this, encoding.toUint8Array(encoder))
    }
    /**
     * Listens to Awareness updates and sends them to remote peers
     *
     * @param {any} changed
     * @param {any} origin
     */
    this._awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
      const changedClients = added.concat(updated).concat(removed)
      const encoderAwareness = encoding.createEncoder()
      encoding.writeVarUint(encoderAwareness, messageAwareness)
      encoding.writeVarUint8Array(
        encoderAwareness,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      )
      broadcastRoomMessage(this, encoding.toUint8Array(encoderAwareness))
    }

    this._beforeUnloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [doc.clientID],
        'window unload'
      )
      rooms.forEach((room) => {
        room.disconnect()
      })
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this._beforeUnloadHandler)
    } else if (typeof process !== 'undefined') {
      process.on('exit', this._beforeUnloadHandler)
    }
  }

  connect () {
    this.doc.on('update', this._docUpdateHandler)
    this.awareness.on('update', this._awarenessUpdateHandler)
    // signal through all available signaling connections
    const roomName = this.name
    bc.subscribe(roomName, this._bcSubscriber)
    this.bcconnected = true
    // broadcast peerId via broadcastchannel
    broadcastBcPeerId(this)
    // write sync step 1
    const encoderSync = encoding.createEncoder()
    encoding.writeVarUint(encoderSync, messageSync)
    syncProtocol.writeSyncStep1(encoderSync, this.doc)
    broadcastBcMessage(this, encoding.toUint8Array(encoderSync))
    // broadcast local state
    const encoderState = encoding.createEncoder()
    encoding.writeVarUint(encoderState, messageSync)
    syncProtocol.writeSyncStep2(encoderState, this.doc)
    broadcastBcMessage(this, encoding.toUint8Array(encoderState))
    // write queryAwareness
    const encoderAwarenessQuery = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness)
    broadcastBcMessage(this, encoding.toUint8Array(encoderAwarenessQuery))
    // broadcast local awareness state
    const encoderAwarenessState = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessState, messageAwareness)
    encoding.writeVarUint8Array(
      encoderAwarenessState,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID
      ])
    )
    broadcastBcMessage(this, encoding.toUint8Array(encoderAwarenessState))

    // ably channel connection

    this.ably = new Ably.Realtime.Promise({
      key: 'YOUR_ABLY_KEY',
      clientId: this.peerId
    })
    this.ably.connection.once('connected').then(() => {
      this.channel = this.ably.channels.get(this.name)
      this.channel.presence.enter()
      initialSync(this)
      this.channel.presence.get().then((members) => {
        members.forEach((member) => {
          if (this.peerId !== member.clientId) {
            this.roomPeers.set(member.clientId, false)
          }
        })
      })
      
      this.channel.presence.subscribe('enter', (member) => {
        if (this.peerId !== member.clientId) {
          this.roomPeers.set(member.clientId, false)
        }
      })

      this.channel.presence.subscribe('leave', (member) => {
        this.roomPeers.delete(member.clientId)
        checkIsSynced(this)
      })
      const onUpdate = (message) => {
        const answer = readPeerMessage(this, message.clientId, new Uint8Array(message.data))
        if (answer !== null) {
          this.channel.publish(message.clientId, encoding.toUint8Array(answer))
        }
      }
      this.channel.subscribe('docUpdated', onUpdate)
      this.channel.subscribe(this.peerId, onUpdate)
    })
  }

  disconnect () {
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      'disconnect'
    )
    // broadcast peerId removal via broadcastchannel
    const encoderPeerIdBc = encoding.createEncoder()
    encoding.writeVarUint(encoderPeerIdBc, messageBcPeerId)
    encoding.writeUint8(encoderPeerIdBc, 0) // remove peerId from other bc peers
    encoding.writeVarString(encoderPeerIdBc, this.peerId)
    broadcastBcMessage(this, encoding.toUint8Array(encoderPeerIdBc))

    bc.unsubscribe(this.name, this._bcSubscriber)
    this.bcconnected = false
    this.doc.off('update', this._docUpdateHandler)
    this.awareness.off('update', this._awarenessUpdateHandler)

    this.ably.close()
  }

  destroy () {
    this.disconnect()
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler)
    } else if (typeof process !== 'undefined') {
      process.off('exit', this._beforeUnloadHandler)
    }
  }
}

/**
 * @param {Y.Doc} doc
 * @param {AblyProvider} provider
 * @param {string} name
 * @param {CryptoKey|null} key
 * @return {Room}
 */
const openRoom = (doc, provider, name, key) => {
  // there must only be one room
  if (rooms.has(name)) {
    //throw error.create(`A Yjs Doc connected to room "${name}" already exists!`)
    return rooms.get(name)
  }
  const room = new Room(doc, provider, name, key)
  rooms.set(name, /** @type {Room} */ (room))
  return room
}

/**
 * @typedef {Object} ProviderOptions
 * @property {Array<string>} [signaling]
 * @property {string} [password]
 * @property {awarenessProtocol.Awareness} [awareness]
 * @property {number} [maxConns]
 * @property {boolean} [filterBcConns]
 * @property {any} [peerOpts]
 */

/**
 * @extends Observable<string>
 */
export class AblyProvider extends Observable {
  /**
   * @param {string} roomName
   * @param {Y.Doc} doc
   * @param {ProviderOptions?} opts
   */
  constructor (
    roomName,
    doc,
    {
      password = null,
      awareness = new awarenessProtocol.Awareness(doc),
      filterBcConns = true
    } = {}
  ) {
    super()
    this.roomName = roomName
    this.doc = doc
    this.filterBcConns = filterBcConns
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = awareness
    this.shouldConnect = false
    /**
     * @type {PromiseLike<CryptoKey | null>}
     */
    this.key = password
      ? cryptoutils.deriveKey(password, roomName)
      : /** @type {PromiseLike<null>} */ (promise.resolve(null))
    /**
     * @type {Room|null}
     */
    this.room = null
    this.key.then((key) => {
      this.room = openRoom(doc, this, roomName, key)
      this.room.connect()
      this.emit('roomconnected', [])
    })
    this.destroy = this.destroy.bind(this)
    doc.on('destroy', this.destroy)
  }

  /**
   * @type {boolean}
   */
  get connected () {
    return this.room !== null && this.shouldConnect
  }

  connect () {
    if (!this.connected) {
      this.room.connect()
    }
    this.shouldConnect = true
  }

  disconnect () {
    if (this.connected) {
      this.room.disconnect()
    }
    this.shouldConnect = false
  }

  destroy () {
    this.doc.off('destroy', this.destroy)
    // need to wait for key before deleting room
    this.key.then(() => {
      /** @type {Room} */ (this.room).destroy()
      rooms.delete(this.roomName)
    })
    super.destroy()
  }
}
