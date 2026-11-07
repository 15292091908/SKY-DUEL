// maps.js —— 本模式的地图目录（地形文件放 maps/ 下；新增地图只改这里）
import { MAP as flat } from './maps/flat.js?v=1510';
import { registerMap } from '../../world/index.js?v=1510';

export const MAPS = [flat];
for (const m of MAPS) registerMap(m);
