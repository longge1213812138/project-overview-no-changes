/**
 * 全局热键：Alt+Space 开合浮窗（DEV_PLAN §6 阶段 3 / F6）。
 *
 * 降级策略：注册失败（被系统或其他软件占用、抛异常）只 console.warn，
 * 不中断启动——托盘菜单「快速问答 (Alt+Space)」仍可作为入口。
 */
import { globalShortcut } from 'electron'
import { toggleFloat } from './windows'

const FLOAT_HOTKEY = 'Alt+Space'

/** whenReady 调用（幂等性由 globalShortcut 自身保证：重复注册同一按键会返回 false） */
export function registerHotkeys(): void {
  try {
    const ok = globalShortcut.register(FLOAT_HOTKEY, () => {
      toggleFloat()
    })
    if (!ok) {
      console.warn(`[hotkeys] ${FLOAT_HOTKEY} 注册失败（可能被系统或其他软件占用），降级为托盘菜单入口`)
    }
  } catch (err) {
    console.warn(`[hotkeys] ${FLOAT_HOTKEY} 注册异常，降级为托盘菜单入口:`, err)
  }
}

/** index.ts 在 will-quit 调用；未注册时 unregisterAll 也是安全的 */
export function unregisterHotkeys(): void {
  try {
    globalShortcut.unregisterAll()
  } catch (err) {
    console.warn('[hotkeys] 解除热键异常:', err)
  }
}
