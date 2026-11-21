// js/modes/tank/net.js —— 本模式的联机契约
//
// groundBoth: 两队**都**开地面载具（坦克）。引擎原来的 groundTeam 只支持单边，
// 这里用 groundBoth 打开双边分支（见 js/units.js）。
// 地图 aaSpawns 的每个点位带 team 字段，出生点按队伍过滤（见 aagunSpawnPos）。
export const NET = {
  hostPrePick: 'none',
  groundTeam: -1,
  groundBoth: true,
  maxSize: 5,
  sync: ['pos', 'bodyYaw', 'turret', 'hp'],
};
