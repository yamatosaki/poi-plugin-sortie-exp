'use strict'

const { poiPlugin } = require('../package.json')
const number = new Intl.NumberFormat('zh-CN')
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
const noShips = Object.freeze({})
const noGameSnapshot = () => noShips
const noGameSubscription = () => () => {}
const knownExp = value => Number.isSafeInteger(value) && value >= 0
const positive = value => Number.isSafeInteger(value) && value > 0

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

  function ShipTile({ ship, live, t }) {
    const masterId = live?.masterId ?? ship.masterId
    const isDamaged = Boolean(live?.isDamaged ?? ship.isDamaged)
    const level = live?.level ?? ship.level
    const kind = live?.kind ?? ship.kind
    const name = t(`resources:${live?.name ?? ship.name}`, { keySeparator: 'chiba' })
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

  function ShipTable({ ships, fleet, total, sum, gameShips }) {
    const { t } = useTranslation(['main', 'resources'])
    return h('div', { className: 'pex-table-scroll' }, h('table', { className: 'pex-table', 'aria-label': '逐舰获得经验' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, '舰娘'),
        h('th', { scope: 'col' }, total ? '总累计经验' : '获得经验'),
        h('th', { scope: 'col' }, '占比'))),
      h('tbody', null, ships.flatMap((ship, index) => {
        const candidate = gameShips[ship.id]
        const live = candidate && (!positive(ship.masterId) || ship.masterId === candidate.masterId) ? candidate : undefined
        const share = knownExp(ship.exp) ? percent.format(sum ? ship.exp / sum : 0) : '—'
        const row = h('tr', { key: ship.id, 'data-ship': ship.id },
          h('td', null, h(ShipTile, { ship, live, t })),
          h('td', { className: `pex-exp${knownExp(ship.exp) ? '' : ' pex-missing'}` }, expText(ship.exp),
            ship.retreated ? h('div', { className: 'pex-muted' }, '已退避') : null),
          h('td', { className: 'pex-share' }, share))
        if (fleet && (index === 0 || ship.group !== ships[index - 1].group)) {
          return [h('tr', { key: `fleet-${ship.id}`, className: 'pex-fleet' },
            h('th', { colSpan: 3 }, ship.group === 'main' ? '主力舰队' : '护卫舰队')), row]
        }
        return [row]
      }))))
  }

  function metric(label, value, unit) {
    return h('div', { className: 'pex-metric' },
      h('div', { className: 'pex-muted' }, label),
      h('strong', { className: 'pex-metric-value' }, value, unit ? h('small', null, unit) : null))
  }

  function details(ships, { total = false, sum, gameShips }) {
    return h('section', { className: 'pex-card' },
      h('header', { className: 'pex-card-heading' }, h('h3', null, total ? '逐舰总累计' : '舰队明细'),
        h('span', { className: 'pex-muted' }, `${number.format(ships.length)} 艘舰船`)),
      ships.length ? h(ShipTable, { ships, fleet: !total && ships.some(ship => ship.group === 'escort'), total, sum, gameShips })
        : h('div', { className: 'pex-empty' }, h('strong', null, total ? '暂无累计经验' : '暂无舰船记录')))
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

  function totalView(view, gameShips) {
    const disabled = !view.accountReady
    const sum = sumExperience(view.totals)
    return h('div', null,
      h('div', { className: 'pex-card pex-context pex-context-total' },
        metric('累计记录', `总累计 ${number.format(view.totalSorties)} 场`, ' 出击'),
        metric('全部舰船合计', expText(sum)),
        h('div', { className: 'pex-total-controls' },
          button(view.tracking ? '累计开启' : '累计关闭', () => tracker.setTracking(!view.tracking), {
            className: 'pex-switch', role: 'switch', 'aria-label': '累计开关', 'aria-checked': view.tracking, disabled,
          }),
          button('清零', () => tracker.clearTotal(), { className: 'pex-button', disabled }))),
      details(view.totals, { total: true, sum, gameShips }))
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
