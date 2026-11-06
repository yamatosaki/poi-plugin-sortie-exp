'use strict'

const noShips = Object.freeze({})
const noTagColors = Object.freeze([])

function positive(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function readShipDisplay(state, owned) {
  const masterId = positive(owned?.api_ship_id)
  const level = positive(owned?.api_lv)
  const nextExp = owned?.api_exp?.[1]
  const master = state?.const?.$ships?.[masterId]
  const kind = state?.const?.$shipTypes?.[master?.api_stype]?.api_name
  const maxHp = positive(owned?.api_maxhp)
  const nowHp = owned?.api_nowhp == null ? NaN : Number(owned.api_nowhp)
  return {
    ...(masterId !== undefined && { masterId }),
    ...(level !== undefined && { level }),
    ...(Number.isSafeInteger(nextExp) && nextExp >= 0 && { nextExp }),
    ...(typeof master?.api_name === 'string' && master.api_name && { name: master.api_name }),
    ...(typeof kind === 'string' && kind && { kind }),
    ...(maxHp !== undefined && Number.isFinite(nowHp) && nowHp >= 0 && { isDamaged: nowHp * 2 <= maxHp }),
  }
}

function createShipProjection(getState, getAccountId, selectAvatarColor) {
  let previousAccount
  let previousOwned
  let previousMaster
  let previousAvatarType
  let previousTagColors
  let projection = noShips

  // useSyncExternalStore needs the same reference until the relevant data changes.
  return () => {
    const state = getState()
    const owner = positive(state?.info?.basic?.api_member_id)
    const account = getAccountId()
    const owned = state?.info?.ships
    const master = state?.const
    if (!owner || String(owner) !== account || !owned) return noShips
    const avatarType = state.config?.poi?.appearance?.avatarType ?? ''
    const tagColors = state.fcd?.shiptag?.color ?? noTagColors
    if (account === previousAccount && owned === previousOwned && master === previousMaster &&
        avatarType === previousAvatarType && tagColors === previousTagColors) return projection
    previousAccount = account
    previousOwned = owned
    previousMaster = master
    previousAvatarType = avatarType
    previousTagColors = tagColors
    projection = Object.fromEntries(Object.entries(owned).flatMap(([id, ship]) => {
      const ownedId = positive(ship?.api_id ?? id)
      if (!ship || ownedId === undefined) return []
      const display = readShipDisplay(state, ship)
      const masterShip = master?.$ships?.[display.masterId]
      if (selectAvatarColor && masterShip) display.avatarColor = selectAvatarColor(ship, masterShip, tagColors, avatarType)
      return [[ownedId, display]]
    }))
    return projection
  }
}

module.exports = { createShipProjection, positive, readShipDisplay }
