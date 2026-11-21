import { Bot } from '../../ai.js?v=1572';

/* 空战对决 AI：喷气机狗斗。
   直接用基类的「攻击 → 脱离 → 再进入」战术（见 js/ai.js 的 Bot.tactics）。
   之所以单独立一个文件：每个玩法的 AI 都应该能独立调参 / 换战术，
   改空战 AI 不该牵动直升机或防空车模式。 */
export class AirBot extends Bot {}
