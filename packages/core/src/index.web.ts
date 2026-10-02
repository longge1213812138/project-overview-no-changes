/**
 * @fairy/core — 渲染层专用入口（web-safe：不含 gateway/ 等 node 内建依赖模块）。
 * electron.vite.config.ts 的 renderer alias 指向这里；类型仍从完整入口解析（tsc 走 package main）。
 */

export * from './constants';
export * from './ipc';
export * from './llm';
