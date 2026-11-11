'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createExperience } = require('./src/experience')
const { createPoiAdapter, storagePath } = require('./src/poi-adapter')
const { createPanel } = require('./src/panel')
const { createShipProjection } = require('./src/poi-ship-data')
const { store } = require(path.join(window.ROOT, 'views', 'create-store'))
const { ShipAvatar, Gradient, ShipBasic, ShipName, ShipSubText, ShipLabel } =
  require(path.join(window.ROOT, 'views', 'components', 'ship-parts', 'styled-components'))
const { selectShipAvatarColor } = require(path.join(window.ROOT, 'views', 'utils', 'game-utils'))
const { useTranslation } = require(path.join(window.ROOT, 'node_modules', 'react-i18next'))

const resourceIcons = Object.fromEntries(Object.entries({ fuel: 1, ammo: 2, steel: 3, bauxite: 4, buckets: 6 })
  .map(([kind, id]) => [kind, pathToFileURL(path.join(window.ROOT, 'assets', 'img', 'material', `0${id}.png`)).href]))

const listeners = new Set()
const tracker = createExperience({
  load: id => window.config.get(storagePath(id), null),
  save: (id, value) => window.config.set(storagePath(id), value),
  notify: () => {
    for (const listener of listeners) listener()
  },
})
const getGameSnapshot = createShipProjection(store.getState, () => tracker.getSnapshot().accountId, selectShipAvatarColor)

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let adapter
const onResponse = event => adapter?.onResponse(event.detail)
const onGameStart = () => adapter?.reset()
const onInterrupt = () => adapter?.interrupt()

exports.pluginDidLoad = () => {
  adapter = createPoiAdapter({ tracker, getState: store.getState, getShipSnapshot: getGameSnapshot })
  window.addEventListener('game.response', onResponse)
  window.addEventListener('game.start', onGameStart)
  window.addEventListener('network.error', onInterrupt)
  window.addEventListener('network.invalid.result', onInterrupt)
}

exports.pluginWillUnload = () => {
  window.removeEventListener('game.response', onResponse)
  window.removeEventListener('game.start', onGameStart)
  window.removeEventListener('network.error', onInterrupt)
  window.removeEventListener('network.invalid.result', onInterrupt)
  adapter = undefined
  tracker.handle({ type: 'account' })
}

exports.reactClass = createPanel(
  require('react'), tracker, subscribe,
  fs.readFileSync(path.join(__dirname, 'src', 'panel.css'), 'utf8'),
  { ShipAvatar, Gradient, ShipBasic, ShipName, ShipSubText, ShipLabel, useTranslation,
    subscribeGame: store.subscribe, getGameSnapshot, resourceIcons },
)
exports.windowMode = false
