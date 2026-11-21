// js/modes/air/net.js —— 本模式的联机契约（模式包自带）
//
// 传输层（WebRTC / 房主小世界 / 信令 / 快照）是共用引擎：js/netev.js + js/sdp.js + js/signal.js。
// 这里只声明"本模式怎么组队、哪边开地面载具、需要同步哪些字段"——换模式不用改联机内核。
// 新增模式：复制本文件改字段即可；mode.js 会把 NET 合并进 MODE 描述符。
export const NET = {
  hostPrePick: 'random',      // 建房时是否预分配阵营：'random' | 'none' | 'manual'
  groundTeam: -1,         // 哪个阵营使用地面防空车（-1 = 双方都空中）
  maxSize: 5,            // 单边最大人数（1v1 ~ 5v5）
  sync: ["pos", "quat", "hp"],   // 房主快照需要同步的字段（文档 / 校验用）
};
