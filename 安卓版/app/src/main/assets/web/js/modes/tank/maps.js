// js/modes/tank/maps.js —— 本模式的地图目录
import { MAP as farm } from './maps/farm.js?v=1572';
import { registerMap } from '../../world/index.js?v=1572';

export const MAPS = [farm];
for (const m of MAPS) registerMap(m);
