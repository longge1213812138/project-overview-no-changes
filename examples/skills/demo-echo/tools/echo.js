/**
 * Fairy Skill 脚本契约演示（阶段 8）：
 * - stdin 收一行 JSON：{ "tool": "<工具名>", "input": <模型入参> }
 * - stdout 打印**单个 JSON 值**（唯一允许写 stdout 的内容，调试请走 stderr）
 * - 退出码 0 = 成功；非 0 = 失败（stderr 尾部会进错误信息）
 * - 环境变量：FAIRY_SKILL_DIR / FAIRY_WORKSPACE_DIR / FAIRY_TOOL_NAME
 */
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const req = JSON.parse(raw);
    const result = {
      ok: true,
      tool: req.tool,
      echoed: req.input,
      env: {
        toolName: process.env.FAIRY_TOOL_NAME,
        skillDir: process.env.FAIRY_SKILL_DIR,
        workspace: process.env.FAIRY_WORKSPACE_DIR,
        // 最小 env 验证：应用侧任何 token/key 都不应出现在这里
        leakedAppSecret: process.env.FAIRY_API_KEY ?? null
      }
    };
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err));
    process.exit(1);
  }
});
