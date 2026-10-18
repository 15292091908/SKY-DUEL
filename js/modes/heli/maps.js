// js/modes/heli/maps.js —— 本模式的地图目录（模式包自带）
// 地形文件在本目录的 maps/ 下；registerMap 把它们登记进共用世界库（js/world/index.js）。
import { MAP as base } from './maps/base.js?v=1516';
import { registerMap } from '../../world/index.js?v=1516';

export const MAPS = [base];
for (const m of MAPS) registerMap(m);
