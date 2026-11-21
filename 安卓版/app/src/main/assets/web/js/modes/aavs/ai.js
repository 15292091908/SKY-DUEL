import { Bot } from '../../ai.js?v=1572';

/* 防空车突袭的 AI 飞机：任务是打地面上的高炮车。
   和空战的区别只有两点，但都写在这里，不污染共享代码：
     ① 目标恒为地面单位（groundTarget = true），不靠"贴地且不动"去猜；
     ② 对地扫射的脱离距离更长（150m），不然贴脸拉不起来会撞地。 */
export class AavsBot extends Bot {
  constructor(plane) {
    super(plane);
    this.groundTarget = true;
    this.standoff = 150;
  }
}
