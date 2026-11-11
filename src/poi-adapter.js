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

function resourceState(state) {
  const { info, const: master } = state ?? {}
  return {
    owner: positive(info?.basic?.api_member_id),
    ships: info?.ships,
    masterShips: master?.$ships,
    slotItems: info?.equips,
    masterSlotItems: master?.$equips,
    fleets: info?.fleets,
    repairDocks: info?.repairs,
    resources: info?.resources,
  }
}

function createPoiAdapter({ tracker, getState, getShipSnapshot }) {
  let memberId
  let awaitingPortFor
  let combined = false
  let previousState = resourceState(getState())
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
    previousState = undefined
    account(undefined)
  }

  function reconcileShips(ships) {
    if (!Array.isArray(ships)) return
    const owned = new Set(ships.map(ship => positive(ship?.api_id)))
    if (owned.has(undefined) || owned.size !== ships.length) return
    const view = tracker.getSnapshot()
    const recorded = new Set([
      ...view.totals.map(ship => ship.id), ...(view.totalShipSelection ?? []), ...(view.resources?.shipIds ?? []),
    ])
    emit('removeShips', { accountId: memberId, ids: [...recorded].filter(id => !owned.has(id)) })
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
      // Poi dispatches to Redux before game.response. The previous response's
      // immutable state contains the stock and dock data before that change.
      const state = getState()
      const capture = {
        path, body, post,
        before: previousState?.owner != null && String(previousState.owner) === memberId ? previousState : {},
        at: Number.isFinite(detail.time) ? detail.time : Date.now(),
      }
      previousState = resourceState(state)
      if (path === 'api_port/port') {
        const id = positive(body.api_basic?.api_member_id)
        if (!id) return
        const confirmed = String(id)
        if (awaitingPortFor && awaitingPortFor !== confirmed) return
        awaitingPortFor = undefined
        account(confirmed)
        emit('port', { accountId: memberId, shipDisplay: shipSnapshot(), capture })
        reconcileShips(body.api_ship)
        return
      }
      if (!memberId) return

      // Poi updates Redux before emitting game.response, including for account changes.
      const hostMemberId = positive(state?.info?.basic?.api_member_id)
      if (hostMemberId && String(hostMemberId) !== memberId) {
        awaitPort(String(hostMemberId))
        return
      }
      if (path === 'api_req_kousyou/destroyship' || path === 'api_req_kaisou/powerup') {
        const modernization = path === 'api_req_kaisou/powerup'
        const target = positive(body.api_ship?.api_id)
        const rawIds = modernization ? post.api_id_items : post.api_ship_id
        const ids = typeof rawIds === 'string' || typeof rawIds === 'number' ? String(rawIds).split(',').map(positive) : []
        const validTarget = !modernization || (target && !ids.includes(target) && (post.api_id == null || positive(post.api_id) === target))
        if (validTarget && ids.length && ids.every(id => id !== undefined)) {
          emit('removeShips', { accountId: memberId, ids, capture })
        } else {
          emit('resource', { capture })
        }
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
          expectsEscort: combined, incomplete: combined && !escort.length, capture,
        })
      } else if (path === 'api_req_map/next') {
        emit('next', { map: getMap(body, post), node: positive(body.api_no), capture })
      } else if (phases.has(path)) {
        const deckId = path.startsWith('api_req_sortie/') ? positive(post.api_deck_id ?? body.api_deck_id) : undefined
        emit('phase', { deckId })
      } else if (path === 'api_req_practice/midnight_battle') {
        emit('practiceNight', { deckId: practiceDeck(body, post) })
      } else if (path === 'api_req_practice/battle_result') {
        emit('practiceResult', { deckId: practiceDeck(body, post), main: body.api_get_ship_exp,
          mvp: body.api_mvp, shipDisplay: shipSnapshot() })
      } else if (path === 'api_req_sortie/battleresult' || path === 'api_req_combined_battle/battleresult') {
        emit('result', { main: body.api_get_ship_exp, escort: body.api_get_ship_exp_combined,
          mvp: body.api_mvp, escortMvp: body.api_mvp_combined })
      } else if (path === 'api_req_sortie/goback_port' || path === 'api_req_combined_battle/goback_port') {
        const positions = state?.sortie?.escapedPos ?? []
        const slots = positions.filter(slot => Number.isSafeInteger(slot) && slot >= 0).map(slot =>
          combined && slot >= 6 ? { group: 'escort', slot: slot - 6 } : { group: 'main', slot })
        emit('retreat', { slots })
      } else {
        emit('resource', { capture })
      }
    },
    reset: () => awaitPort(),
    interrupt: () => {
      previousState = undefined
      emit('interrupt')
    },
  }
}

// poi writes dotted config paths with lodash, where numeric keys imply arrays.
const storagePath = id => `plugin.poi-plugin-sortie-exp.experience.v1.member_${id}`

module.exports = { createPoiAdapter, storagePath }
