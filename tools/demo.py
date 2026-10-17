"""Demo / development mode: the real UI and engine answering with canned replies (no API keys, no network, separate data folder).

    python tools/demo.py [port]      then open the printed address in any browser (or use 演示模式.cmd)
"""
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault('AI_ROUNDTABLE_DATA', str(Path(tempfile.gettempdir()) / 'rt-demo-data'))
sys.path.insert(0, str(ROOT / 'vendor'))
sys.path.insert(0, str(ROOT))
import core, engine  # noqa: E402
from controller import Controller  # noqa: E402
from server import Server  # noqa: E402

REPLIES = {
    'Claude': '先把目标说清楚，再谈方案。\n\n**我的判断**：这件事的关键不是“做不做”，而是“先验证什么”。\n\n1. 用一周时间做最小版本\n2. 只测一个核心假设\n   - 用户是否愿意每天打开\n   - 是否比现在的方式更省时间\n3. 结果不好就及时停\n\n> 不要为了同意而同意，这里有一个风险：需求还没有被证明。\n\n```python\ndef verdict(data):\n    return "go" if data["retention"] > 0.4 else "stop"\n```',
    'GPT': '我补充一个执行层面的方案：\n\n| 阶段 | 目标 | 产出 |\n| --- | --- | --- |\n| 第 1 天 | 写清楚假设 | 一页纸 |\n| 第 3 天 | 原型 | 可点击 Demo |\n| 第 7 天 | 找 5 个人试 | 反馈表 |\n\n下一步：先列出你**最担心**的三件事。',
    'Gemini': '从另一个角度看，有两个反例值得先排除：\n\n- 已有工具其实够用（例如 [备忘录](https://example.com)）\n- 需求来自你自己，而不是用户\n\n事实：目前没有数据；推测：留存会偏低。`retention` 是最该先量的指标。',
}


def writing_reply(name, prompt, instructions=''):
    flavour = {'Claude': '细腻', 'GPT': '清晰', 'Gemini': '新颖'}[name]
    if '点评与修改说明' in instructions:
        return (f'{name}修改后的稿件：开头先抛出结论，语气更活泼，结尾保持不变。\n\n第二段补上一个具体的例子。\n'
                '<<<说明>>>\n### 主要问题\n- 开头偏平，没有钩子\n- 第二段缺少例子\n### 做了哪些修改\n- 先抛结论\n- 补了例子\n### 没有改的及原因\n- 结尾保留，已经有记忆点')
    if '【待评审的' in prompt:
        return ('## 评分\n\n| 稿 | 结构 | 文笔 | 总分 |\n| --- | --- | --- | --- |\n| A | 8 | 9 | 8.5 |\n| B | 9 | 8 | 8.5 |\n| C | 7 | 8 | 7.5 |\n\n'
                '## 排名与理由\n稿 A 和稿 B 并列，A 的开头更抓人。\n\n## 融合建议\n以 A 为底稿，借 B 的结尾。')
    if '底稿（' in prompt:
        return (f'# 融合稿\n\n这是一版由{name}融合的稿子：开头沿用底稿，结尾借鉴另一版，整体语气统一。\n\n'
                '<<<说明>>>\n- 开头沿用底稿\n- 结尾借鉴稿 B\n- 统一了人称')
    if '【需要修改的文字】' in prompt:
        return f'{name}改写后的这一段，更{flavour}，也更有画面感。\n<<<说明>>>\n调整了语序，换掉了两处空话。'
    if '评审维度' in prompt:
        return '## 总评\n结构清楚，但开头偏平。\n\n## 最需要改的 3 处\n1. 开头 → 太慢 → 先抛结论。'
    return (f'# {flavour}的开头\n\n这是{name}写的一版，风格偏{flavour}。\n\n第一段先用一个具体的场景切入，让读者立刻明白发生了什么。\n\n'
            '第二段给出核心观点，并用一个新鲜的类比讲清楚。\n\n结尾留一个可以马上行动的小建议。')


def fake_api_reply(cfg, instructions, prompt, cancel, on_delta, media=None):
    name = next((n for n in core.NAMES if core.DISPLAY_NAMES[n] in instructions), 'Claude')
    if os.environ.get('FAKE_FAIL') == name:
        raise core.APIError(500, '上游服务暂时不可用（模拟错误）')
    text = REPLIES[name]
    if '写作团队' in instructions:
        text = writing_reply(name, prompt, instructions)
    for i in range(0, len(text), 6):
        cancel.check()
        time.sleep(0.2 if os.environ.get('FAKE_SLOW') else 0.02)
        on_delta(text[i:i + 6])
    cfg['_usage']({'usage': {'input_tokens': 1200, 'output_tokens': 380}})
    if os.environ.get('FAKE_TRUNC') == name and '续写自己刚才' not in instructions:
        raise RuntimeError('回复达到输出长度上限。可以提高上限后重试。')   # simulate a long chapter hitting the cap
    return text


core.api_reply = fake_api_reply
controller = Controller(core.DATA)
for p in engine.PLATFORMS:
    controller.settings['_platforms'][p]['key'] = 'fake-' + p
engine.PRICE_DATES.update({p: time.strftime('%Y-%m-%d') for p in engine.PLATFORMS})
server = Server(controller, int(next((a for a in sys.argv[1:] if a.isdigit()), 0)))
print(server.url(), flush=True)
if '--no-window' not in sys.argv:
    from app import open_window
    open_window(server.url())
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
