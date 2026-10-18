// js/modes/air/maps.js —— 空战的地图目录（本模式包自带，新增/删除地图只改这里）
// 地形文件在本目录的 maps/ 下；registerMap 把它们登记进共用世界库（js/world/index.js）。
import { MAP as island } from './maps/island.js?v=1516';
import { MAP as city } from './maps/city.js?v=1516';
import { MAP as base } from './maps/base.js?v=1516';
import { registerMap } from '../../world/index.js?v=1516';

export const MAPS = [island, city];   // 可选地图（大厅只展示这两张）
registerMap(base);                    // 大厅展示用基地图：登记但不进 MAPS，不出现在选图卡里
for (const m of MAPS) registerMap(m);
