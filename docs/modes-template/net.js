// net.js —— 本模式的联机契约（模式包自带；传输层是共用的 js/netev.js + js/sdp.js）
export const NET = {
  hostPrePick: 'random',   // 'random' 建房先随机分 / 'none' 留到开局前分配 / 'manual' 房主手动
  groundTeam: -1,          // 哪个阵营开地面载具（-1 = 双方都空中）
  maxSize: 5,              // 单边最大人数（1v1~5v5）
  sync: ['pos', 'quat', 'hp'],   // 房主快照需要同步的字段（文档/校验用）
};
