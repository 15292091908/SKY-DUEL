// js/modes/heli2/maps.js —— 本模式的地图目录（模式包自带）
// 地形文件在本目录的 maps/ 下；registerMap 把它们登记进共用世界库（js/world/index.js）。
import { MAP as oilrig } from './maps/oilrig.js?v=1572';
import { registerMap } from '../../world/index.js?v=1572';

export const MAPS = [oilrig];
for (const m of MAPS) registerMap(m);
