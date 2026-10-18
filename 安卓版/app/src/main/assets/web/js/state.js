// js/state.js — 《苍穹对决》共享可变状态（v3.3 从 main.js 抽出）
// 约定：
//  · 容器类（对象/Map/数组）用 const 导出 —— 引用不变，各模块使用处**零改动**。
//  · 标量类用 export let + setXxx() 写入 —— import 是实时绑定，**读取处零改动**，只有赋值处改为 setter。
// 这样拆分无需大规模改写引用，显著降低回归风险。

/* ---------- 容器（直接改属性/增删键，无需求 setter） ---------- */
import { makePeerId } from './net.js?v=1516';

// 本机玩家 ID（全生命周期不变，故用 const 导出）
export const myPeerId = makePeerId();

export const STATE = {};   // 回合/比分/局号等对局状态
export const planes = {};   // id -> 飞机实体
export const aaguns = {};   // id -> 防空车实体
export const nets = {};   // peerId -> Net
export const killLedger = {};   // id -> {k,d} 权威击杀台账
export const pingProbe = {};   // 房主：延迟探测 id -> {samples,sent,timer}
export const crashPairs = new Map();   // 房主：碰撞去重
export const hitSettled = new Map();   // 房主：已结算命中（防重复）
export const markerPool = [];   // IFF 标记池
export const lastEventSeq = {};   // event 通道去重
export const lastUpdSeq = {};   // state 通道 upd 去重
export const lastSyncSeq = {};   // sync 快照去重
export const pickSelections = {};   // 房主：peerId -> 0/1 分配记录

/* ---------- 标量（写：setXxx；读：直接 import 名字） ---------- */
export let myTeam = 0;
export let mySlot = 0;
export let mode = null;
export let practiceSize = 2;
export let netSize = 2;
export let hostPeerId = null;
export let roster = [];
export let iAmHost = false;
export let myName = '';
export let hostNameHint = '';
export let pickDealPending = false;
export let myPlane = null;
export let me = null;
export let myAAGun = null;
export let meAAGun = null;
export let meIsAAGun = false;
export let bot = null;
export let gamemode = 'dogfight';
export let world = null;
export let fireT = 0;
export let killCount = 0;
export let aagunWeapon = 'mg';
export let rocketAmmo = 1;
export let planeWeapon = 'gun';
export let heAmmo = 30;
export let sbRows = [];   // 最近一次赛后战绩（渲染 + 导出）
export let lastDmgFrom = null;
export let pickPhase = false;
export let pickRound = 0;
export let pickTimer = null;
export let pickDrag = null;
export let pickBtnsBound = false;
export let myPickSide = -1;
export let pickStartTs = 0;
export let mapLobbyTimerId = null;
export let lobbyPickedMap = null;
export let myFireSeq = 0;
export let crashCd = 0;
export let aimYaw = 0;      // 视角偏移（飞机朝向 + aim = 视角方向；输入层写 / 相机与准星读）
export let aimPitch = 0;
export let zoom = false;    // 开镜（鼠标右键 / 触屏瞄准键）

export function setMyTeam(v) { myTeam = v; }
export function setMySlot(v) { mySlot = v; }
export function setMode(v) { mode = v; }
export function setPracticeSize(v) { practiceSize = v; }
export function setNetSize(v) { netSize = v; }
export function setHostPeerId(v) { hostPeerId = v; }
export function setRoster(v) { roster = v; }
export function setIAmHost(v) { iAmHost = v; }
export function setMyName(v) { myName = v; }
export function setHostNameHint(v) { hostNameHint = v; }
export function setPickDealPending(v) { pickDealPending = v; }
export function setMyPlane(v) { myPlane = v; }
export function setMe(v) { me = v; }
export function setMyAAGun(v) { myAAGun = v; }
export function setMeAAGun(v) { meAAGun = v; }
export function setMeIsAAGun(v) { meIsAAGun = v; }
export function setBot(v) { bot = v; }
export function setGamemode(v) { gamemode = v; }
export function setWorld(v) { world = v; }
export function setFireT(v) { fireT = v; }
export function setKillCount(v) { killCount = v; }
export function setAagunWeapon(v) { aagunWeapon = v; }
export function setRocketAmmo(v) { rocketAmmo = v; }
export function setPlaneWeapon(v) { planeWeapon = v; }
export function setHeAmmo(v) { heAmmo = v; }
export function setSbRows(v) { sbRows = v; }
export function setLastDmgFrom(v) { lastDmgFrom = v; }
export function setPickPhase(v) { pickPhase = v; }
export function setPickRound(v) { pickRound = v; }
export function setPickTimer(v) { pickTimer = v; }
export function setPickDrag(v) { pickDrag = v; }
export function setPickBtnsBound(v) { pickBtnsBound = v; }
export function setMyPickSide(v) { myPickSide = v; }
export function setPickStartTs(v) { pickStartTs = v; }
export function setMapLobbyTimerId(v) { mapLobbyTimerId = v; }
export function setLobbyPickedMap(v) { lobbyPickedMap = v; }
export function setMyFireSeq(v) { myFireSeq = v; }
export function setCrashCd(v) { crashCd = v; }
export function setAimYaw(v) { aimYaw = v; }
export function setAimPitch(v) { aimPitch = v; }
export function setZoom(v) { zoom = v; }
