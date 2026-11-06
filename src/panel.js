'use strict'

const { poiPlugin } = require('../package.json')
const number = new Intl.NumberFormat('zh-CN')
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
const noShips = Object.freeze({})
const noGameSnapshot = () => noShips
const noGameSubscription = () => () => {}
const knownExp = value => Number.isSafeInteger(value) && value >= 0
const positive = value => Number.isSafeInteger(value) && value > 0

function matchingGameShip(ship, gameShips) {
  const candidate = gameShips[ship.id]
  return candidate && (!positive(ship.masterId) || ship.masterId === candidate.masterId) ? candidate : undefined
}

function displayName(ship, live, t) {
  return t(`resources:${live?.name ?? ship.name}`, { keySeparator: 'chiba' })
}

function sumExperience(ships) {
  return ships.length ? ships.reduce((sum, ship) => knownExp(ship.exp) ? (sum ?? 0) + ship.exp : sum, null) : 0
}

function createPanel(React, tracker, subscribe, css, {
  ShipAvatar, Gradient, ShipBasic, ShipName, ShipSubText, ShipLabel, useTranslation,
  subscribeGame = noGameSubscription, getGameSnapshot = noGameSnapshot,
}) {
  const h = React.createElement
  const button = (label, onClick, options = {}) => h('button', { type: 'button', onClick, ...options }, label)
  const expText = value => knownExp(value)
    ? [`${value > 0 ? '+' : ''}${number.format(value)}`, h('small', { key: 'unit' }, ' EXP')]
    : '未捕获'

  function ShipTile({ ship, live, name, t }) {
    const masterId = live?.masterId ?? ship.masterId
    const isDamaged = Boolean(live?.isDamaged ?? ship.isDamaged)
    const level = live?.level ?? ship.level
    const kind = live?.kind ?? ship.kind
    const nextExp = live?.nextExp ?? ship.nextExp
    const [failed, setFailed] = React.useState(null)
    const artKey = `${masterId}:${isDamaged}`
    return h('div', {
      className: 'bp6-card pex-ship-tile',
      onErrorCapture: () => setFailed(artKey),
      onLoadCapture: () => setFailed(null),
    },
    positive(masterId) ? h(ShipAvatar, {
      className: `pex-native-avatar${failed === artKey ? ' pex-avatar-unavailable' : ''}`,
      mstId: masterId, isDamaged, height: 58, useFixedWidth: false, useDefaultBG: false,
    }) : null,
    h(Gradient, { color: live?.avatarColor ?? ship.avatarColor }),
    h(ShipBasic, { avatar: true, className: 'ship-basic' },
      h('span', { className: 'ship-lv' }, 'Lv. ', positive(level) ? level : '??'),
      h(ShipLabel, { className: 'ship-type' }, kind ? t(`resources:${kind}`) : '??')),
    h(ShipName, { avatar: true, className: 'ship-name', title: name }, name),
    h(ShipSubText, { avatar: true, className: 'ship-exp' }, 'Next. ', knownExp(nextExp) ? nextExp : '—'))
  }

  function ShipTable({ ships, fleet, total, sum, gameShips, selection }) {
    const { t } = useTranslation(['main', 'resources'])
    return h('table', {
      className: selection ? 'pex-table pex-filter-table' : 'pex-table',
      'aria-label': selection ? '已统计舰娘' : '逐舰获得经验',
    },
      selection ? h('colgroup', null, h('col', { className: 'pex-filter-column' }), h('col', { span: 3 })) : null,
      h('thead', null, h('tr', null,
        selection ? h('th', { scope: 'col', className: 'pex-filter-checkbox' }, '显示') : null,
        h('th', { scope: 'col' }, '舰娘'),
        h('th', { scope: 'col' }, total ? '总累计经验' : '获得经验'),
        h('th', { scope: 'col' }, '占比'))),
      h('tbody', null, ships.flatMap((ship, index) => {
        const live = matchingGameShip(ship, gameShips)
        const name = displayName(ship, live, t)
        const share = knownExp(ship.exp) ? percent.format(sum ? ship.exp / sum : 0) : '—'
        const row = h('tr', { key: ship.id, 'data-ship': ship.id },
          selection ? h('td', { className: 'pex-filter-checkbox' },
            h('label', null, h('input', {
              type: 'checkbox', 'aria-label': `显示 ${name}`, checked: selection.ids.has(ship.id),
              onChange: event => selection.toggle(ship.id, event.target.checked),
            }))) : null,
          h('td', null, h(ShipTile, { ship, live, name, t })),
          h('td', { className: `pex-exp${knownExp(ship.exp) ? '' : ' pex-missing'}` }, expText(ship.exp),
            ship.retreated ? h('div', { className: 'pex-muted' }, '已退避') : null),
          h('td', { className: 'pex-share' }, share))
        if (fleet && (index === 0 || ship.group !== ships[index - 1].group)) {
          return [h('tr', { key: `fleet-${ship.id}`, className: 'pex-fleet' },
            h('th', { colSpan: 3 }, ship.group === 'main' ? '主力舰队' : '护卫舰队')), row]
        }
        return [row]
      })))
  }

  function metric(label, value, unit) {
    return h('div', { className: 'pex-metric' },
      h('div', { className: 'pex-muted' }, label),
      h('strong', { className: 'pex-metric-value' }, value, unit ? h('small', null, unit) : null))
  }

  function details(ships, { total = false, sum, gameShips, totalCount = ships.length, customize }) {
    const count = ships.length === totalCount ? `${number.format(totalCount)} 艘舰船`
      : `显示 ${number.format(ships.length)} / ${number.format(totalCount)} 艘`
    const empty = totalCount ? '当前未显示任何舰娘' : total ? '暂无累计经验' : '暂无舰船记录'
    return h('section', { className: 'pex-card' },
      h('header', { className: 'pex-card-heading' }, h('h3', null, total ? '逐舰总累计' : '舰队明细'),
        h('div', { className: 'pex-card-controls' }, h('span', { className: 'pex-muted' }, count), customize)),
      ships.length ? h(ShipTable, { ships, fleet: !total && ships.some(ship => ship.group === 'escort'), total, sum, gameShips })
        : h('div', { className: 'pex-empty' }, h('strong', null, empty)))
  }

  function runView(view, gameShips) {
    const run = view.current ?? view.last
    if (!run) return h('div', { className: 'pex-card pex-empty' },
      h('strong', null, view.accountReady ? '暂无出击记录' : '等待游戏账号'),
      h('span', null, view.accountReady ? '普通出击或演习结算后，这里会显示逐舰经验。' : '登录游戏并进入母港即可开始记录。'))
    const live = Boolean(view.current)
    const practice = run.kind === 'practice'
    const status = practice ? (live ? '演习中' : '演习已结算') : (live ? '出击中' : '已返港')
    const sum = sumExperience(run.ships)
    return h('div', null,
      h('div', { className: 'pex-card pex-context', 'aria-live': 'polite' },
        metric(practice ? '出击类型' : '海域', practice ? '演习' : run.map),
        metric('出击舰队', `第 ${run.deckId} 舰队`),
        metric('已结算', number.format(run.battles), ' 场战斗'),
        metric(practice ? '本次演习合计' : '本次舰队合计', sum === null ? '—' : expText(sum)),
        h('span', { className: 'pex-status' }, status)),
      run.incomplete ? h('p', { className: 'pex-warning' }, '数据不完整，仅显示已确认经验。') : null,
      details(run.ships, { sum, gameShips }))
  }

  function ClearTotalButton({ accountId, disabled }) {
    const dialog = React.useRef(null)
    const titleId = React.useId()
    const descriptionId = React.useId()
    const close = () => dialog.current.close()
    const confirm = () => {
      close()
      if (tracker.getSnapshot().accountId === accountId) tracker.clearTotal()
    }

    return h(React.Fragment, null,
      button('清零', () => dialog.current.showModal(), {
        className: 'pex-button pex-clear-button', 'aria-haspopup': 'dialog', disabled,
      }),
      h('dialog', {
        ref: dialog, className: 'pex-clear-dialog', 'aria-labelledby': titleId, 'aria-describedby': descriptionId,
      },
      h('h3', { id: titleId }, '是否清零总累计记录？'),
      h('p', { id: descriptionId }, '将清除当前账号的累计出击场数和经验。'),
      h('div', { className: 'pex-clear-actions' },
        button('取消', close, { className: 'pex-button' }),
        button('确认', confirm, { className: 'pex-button pex-clear-confirm' }))))
  }

  function TotalShipFilter({ view, sum, gameShips }) {
    const { t } = useTranslation(['main', 'resources'])
    const dialog = React.useRef(null)
    const titleId = React.useId()
    const [query, setQuery] = React.useState('')
    const [isOpen, setIsOpen] = React.useState(false)
    const [draft, setDraft] = React.useState(null)
    const ships = view.totals
    const selected = new Set(draft ?? ships.map(ship => ship.id))
    const shown = ships.filter(ship => selected.has(ship.id)).length
    const search = query.trim().toLocaleLowerCase()
    const matches = search ? ships.filter(ship => {
      const live = matchingGameShip(ship, gameShips)
      return displayName(ship, live, t).toLocaleLowerCase().includes(search)
    }) : ships
    const toggle = (id, checked) => {
      setDraft(previous => {
        const next = new Set(previous ?? ships.map(ship => ship.id))
        if (checked) next.add(id)
        else next.delete(id)
        return ships.every(ship => next.has(ship.id)) ? null : [...next]
      })
    }
    const open = () => {
      setQuery('')
      setDraft(view.totalShipSelection)
      dialog.current.showModal()
      setIsOpen(true)
    }
    const close = () => dialog.current.close()
    const confirm = () => {
      const current = tracker.getSnapshot()
      if (current.accountId === view.accountId && draft !== current.totalShipSelection) {
        tracker.setTotalShipSelection(draft)
      }
      close()
    }

    return h(React.Fragment, null,
      button('自定义显示', open, { className: 'pex-button', 'aria-haspopup': 'dialog', disabled: !view.accountReady }),
      h('dialog', {
        ref: dialog, className: 'pex-filter-dialog', 'aria-labelledby': titleId,
        onClose: event => setIsOpen(event.currentTarget.open),
      },
        h('h3', { id: titleId }, '自定义显示舰娘'),
        h('p', null, '点击「完成」后应用显示设置。隐藏的舰娘仍会累计经验。'),
        h('input', {
          className: 'pex-filter-search', type: 'search', value: query, placeholder: '搜索舰娘',
          'aria-label': '搜索舰娘', onChange: event => setQuery(event.target.value),
        }),
        h('div', { className: 'pex-filter-tools' },
          h('span', { className: 'pex-muted', 'aria-live': 'polite' }, `已选 ${shown} / ${ships.length} 艘`),
          button('显示全部', () => setDraft(null), { className: 'pex-button' }),
          button('全部隐藏', () => setDraft([]), { className: 'pex-button', disabled: !ships.length })),
        isOpen && (matches.length ? h('div', { className: 'pex-filter-list' },
          h(ShipTable, { ships: matches, total: true, sum, gameShips, selection: { ids: selected, toggle } }))
          : h('p', null, ships.length ? '没有匹配的舰娘' : '暂无已统计的舰娘')),
        h('div', { className: 'pex-clear-actions' },
          button('取消', close, { className: 'pex-button' }),
          button('完成', confirm, { className: 'pex-button pex-filter-done' }))))
  }

  function totalView(view, gameShips) {
    const disabled = !view.accountReady
    const sum = sumExperience(view.totals)
    const selection = view.totalShipSelection === null ? null : new Set(view.totalShipSelection)
    const ships = selection === null ? view.totals : view.totals.filter(ship => selection.has(ship.id))
    return h('div', null,
      h('div', { className: 'pex-card pex-context pex-context-total' },
        metric('累计记录', `总累计 ${number.format(view.totalSorties)} 场`, ' 出击'),
        metric('全部舰船合计', expText(sum)),
        h('div', { className: 'pex-total-controls' },
          button(view.tracking ? '累计开启' : '累计关闭', () => tracker.setTracking(!view.tracking), {
            className: 'pex-switch', role: 'switch', 'aria-label': '累计开关', 'aria-checked': view.tracking, disabled,
          }),
          h(ClearTotalButton, { key: view.accountId, accountId: view.accountId, disabled }))),
      details(ships, {
        total: true, sum, gameShips, totalCount: view.totals.length,
        customize: h(TotalShipFilter, { key: view.accountId, view, sum, gameShips }),
      }))
  }

  return function ExperiencePanel() {
    const view = React.useSyncExternalStore(subscribe, tracker.getSnapshot, tracker.getSnapshot)
    const gameShips = React.useSyncExternalStore(subscribeGame, getGameSnapshot, getGameSnapshot) ?? noShips
    const [tab, setTab] = React.useState('run')
    return h('section', { className: 'pex', 'aria-label': poiPlugin.name },
      h('style', null, css),
      h('header', { className: 'pex-header' },
        h('div', { className: 'pex-kicker' }, 'SORTIE EXPERIENCE'), h('h2', null, poiPlugin.name)),
      h('div', { className: 'pex-tabs', 'aria-label': '经验统计视图' },
        button(view.current ? '本次出击' : '上次出击', () => setTab('run'), { 'aria-pressed': tab === 'run' }),
        button('总累计', () => setTab('total'), { 'aria-pressed': tab === 'total' })),
      h('div', { className: 'pex-content', 'data-tone': tab === 'run' && view.current ? 'live' : 'done' },
        view.storageError ? h('p', { className: 'pex-warning', role: 'status' }, '本地统计暂时无法读取或保存。') : null,
        tab === 'run' ? runView(view, gameShips) : totalView(view, gameShips)))
  }
}

module.exports = { createPanel }
