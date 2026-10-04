/**
 * Fairy 演示 MCP 服务器（阶段 8 GUI 验收用，stdio / JSON-RPC 2.0 行协议）。
 *
 * 添加方式（设置 → MCP 服务器 → 添加服务器）：
 *   名称：demo-mcp
 *   启动命令：<node.exe 绝对路径，如 C:\Users\<你>\.fairy-tools\node24\node-v24.21.0-win-x64\node.exe>
 *   参数：C:\Users\91533\Desktop\Fairy.worktrees\project-overview-no-changes\examples\mcp-demo-server.js
 *   环境变量：（可留空；填 DEMO_TOKEN=abc123 可顺带验证 DPAPI 存储——列表只显示 KEY 名）
 *
 * 提供工具：
 * - demo_greet：按名字问好（读取 DEMO_TOKEN 并回显其**是否存在**，不回显值）
 * - demo_time：返回服务端当前时间
 */
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });

const TOOLS = [
  {
    name: 'demo_greet',
    description: '按名字生成问候（演示 MCP 工具调用）',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, description: '要问候的名字' } },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'demo_time',
    description: '返回服务端当前时间（演示无入参工具）',
    inputSchema: { type: 'object' }
  }
];

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    return; // 非法行忽略（协议层各自宽容）
  }

  if (msg.method === 'initialize') {
    send({
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fairy-demo-mcp', version: '1.0.0' }
      }
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return;

  if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === 'tools/call') {
    const params = msg.params || {};
    if (params.name === 'demo_greet') {
      const name = params.arguments && params.arguments.name;
      if (typeof name !== 'string' || name.trim() === '') {
        send({ id: msg.id, result: { content: [{ type: 'text', text: '缺少 name 参数' }], isError: true } });
        return;
      }
      const hasToken = typeof process.env.DEMO_TOKEN === 'string' && process.env.DEMO_TOKEN !== '';
      send({
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ greeting: `你好，${name}！（来自 demo-mcp）`, tokenConfigured: hasToken })
            }
          ]
        }
      });
      return;
    }
    if (params.name === 'demo_time') {
      send({
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ now: new Date().toISOString() }) }] }
      });
      return;
    }
    send({ id: msg.id, error: { code: -32602, message: `未知工具：${params.name}` } });
    return;
  }

  if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
