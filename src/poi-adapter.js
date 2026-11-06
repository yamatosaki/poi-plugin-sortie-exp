'use strict'

const { createShipProjection, positive, readShipDisplay } = require('./poi-ship-data')

const prefix = '/kcsapi/'
const phases = new Set([
  ...['battle', 'airbattle', 'ld_airbattle', 'ld_shooting'].map(name => `api_req_sortie/${name}`),
  ...[
    'battle', 'battle_water', 'airbattle', 'ld_airbattle', 'ld_shooting', 'ec_battle',
    'each_battle', 'each_battle_water', 'midnight_battle', 'sp_midnight',
    'ec_midnight_battle', 'ec_night_to_day',
  ].map(name => `api_req_combined_battle/${name}`),
  'api_req_battle_midnight/battle', 'api_req_battle_midnight/sp_midnight',
])

function getMap(body, post) {
  const area = positive(body.api_maparea_id ?? post.api_maparea_id)
  const map = positive(body.api_mapinfo_no ?? post.api_mapinfo_no)
  return area && map ? `${area}-${map}` : undefined
}

function practiceDeck(body, post) {
  const returned = positive(body.api_deck_id)
  const requested = positive(post.api_deck_id)
  return returned && requested && returned !== requested ? 0 : returned ?? requested
}

function deckRoster(state, deckId, group) {
  const fleets = Object.values(state?.info?.fleets ?? {})
  const fleet = fleets.find(row => positive(row?.api_id) === deckId)
  if (!Array.isArray(fleet?.api_ship)) return []
  return fleet.api_ship.flatMap((rawId, slot) => {
    const id = positive(rawId)
    if (id === undefined) return []
    return [{ id, slot, group, name: '未知舰船', ...readShipDisplay(state, state.info.ships?.[id]) }]
  })
}

function createPoiAdapter({ tracker, getState, getShipSnapshot }) {
  let memberId
  let awaitingPortFor
  let combined = false
  const seen = new Set()
  const emit = (type, data) => tracker.handle({ type, ...data })
  const shipSnapshot = getShipSnapshot ?? createShipProjection(getState, () => memberId)

  function account(id) {
    if (id !== memberId) combined = false
    memberId = id
    emit('account', { accountId: id })
  }

  function awaitPort(id) {
    awaitingPortFor = id
    account(undefined)
  }

  return {
    onResponse(detail) {
      if (!detail?.path?.startsWith(prefix)) return
      const path = detail.path.slice(prefix.length)
      const envelope = detail.body ?? {}
      if (envelope.api_result != null && Number(envelope.api_result) !== 1) return
      const body = envelope.api_data ?? envelope
      const post = detail.postBody ?? {}

      // The host time identifies re-delivery of the same response. Distinct
      // results still need an active phase, even when the time differs.
      if (Number.isFinite(detail.time)) {
        const key = `${path}:${detail.time}`
        if (seen.has(key)) return
        seen.add(key)
        if (seen.size > 96) seen.delete(seen.values().next().value)
      }

      if (path === 'api_start2/getData') {
        awaitPort()
        return
      }
      if (path === 'api_get_member/require_info' || path === 'api_get_member/basic') {
        const id = positive(body.api_basic?.api_member_id ?? body.api_member_id)
        if (id && String(id) !== memberId) awaitPort(String(id))
        return
      }
      if (path === 'api_port/port') {
        const id = positive(body.api_basic?.api_member_id)
        if (!id) return
        const confirmed = String(id)
        if (awaitingPortFor && awaitingPortFor !== confirmed) return
        awaitingPortFor = undefined
        account(confirmed)
        emit('port', { accountId: memberId, shipDisplay: shipSnapshot() })
        return
      }
      if (!memberId) return

      // Poi updates Redux before emitting game.response, including for account changes.
      const state = getState()
      const hostMemberId = positive(state?.info?.basic?.api_member_id)
      if (hostMemberId && String(hostMemberId) !== memberId) {
        awaitPort(String(hostMemberId))
        return
      }
      if (path === 'api_req_map/start' || path === 'api_req_practice/battle') {
        const isPractice = path === 'api_req_practice/battle'
        const deckId = isPractice ? practiceDeck(body, post) : positive(post.api_deck_id ?? body.api_deck_id)
        combined = !isPractice && deckId === 1 && positive(state?.sortie?.combinedFlag) !== undefined
        const main = deckRoster(state, deckId, 'main')
        const escort = combined ? deckRoster(state, 2, 'escort') : []
        emit(isPractice ? 'practice' : 'sortie', {
          deckId, map: getMap(body, post), node: positive(body.api_no),
          roster: main.length ? [...main, ...escort] : [],
          expectsEscort: combined, incomplete: combined && !escort.length,
        })
      } else if (path === 'api_req_map/next') {
        emit('next', { map: getMap(body, post), node: positive(body.api_no) })
      } else if (phases.has(path)) {
        const deckId = path.startsWith('api_req_sortie/') ? positive(post.api_deck_id ?? body.api_deck_id) : undefined
        emit('phase', { deckId })
      } else if (path === 'api_req_practice/midnight_battle') {
        emit('practiceNight', { deckId: practiceDeck(body, post) })
      } else if (path === 'api_req_practice/battle_result') {
        emit('practiceResult', { deckId: practiceDeck(body, post), main: body.api_get_ship_exp, shipDisplay: shipSnapshot() })
      } else if (path === 'api_req_sortie/battleresult' || path === 'api_req_combined_battle/battleresult') {
        emit('result', { main: body.api_get_ship_exp, escort: body.api_get_ship_exp_combined })
      } else if (path === 'api_req_sortie/goback_port' || path === 'api_req_combined_battle/goback_port') {
        const positions = state?.sortie?.escapedPos ?? []
        const slots = positions.filter(slot => Number.isSafeInteger(slot) && slot >= 0).map(slot =>
          combined && slot >= 6 ? { group: 'escort', slot: slot - 6 } : { group: 'main', slot })
        emit('retreat', { slots })
      }
    },
    reset: () => awaitPort(),
    interrupt: () => emit('interrupt'),
  }
}

// poi writes dotted config paths with lodash, where numeric keys imply arrays.
const storagePath = id => `plugin.poi-plugin-sortie-exp.experience.v1.member_${id}`

module.exports = { createPoiAdapter, storagePath }
