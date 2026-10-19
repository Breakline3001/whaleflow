# WhaleFlow CLI（`wf`）

给人和 AI 代理操作 WhaleFlow 项目的命令行入口。所有命令输出 **JSON**，方便代理直接解析。

```powershell
node bin/wf.mjs help          # 或 bin\wf.cmd help
```

## 它能做什么 / 不能做什么

| 能做 | 不能做 |
| --- | --- |
| 建项目、加节点、写剧本、加镜头 | 调用模型生成图片或视频 |
| 把镜头编译成待执行的任务节点 | 读取或写入模型凭据 |
| 校验项目结构、导出项目 | 替换桌面程序的执行链路 |

**为什么不能生成**：模型密钥以 DPAPI 密文存在本机，只有 C# 宿主能解密。CLI 拿不到密钥，也就不去碰。它把活干到“任务节点已就位”，剩下一步在桌面程序里点一下就开始跑。

这个边界是故意的：与其让 CLI 偷偷用环境变量里的密钥，不如让它根本碰不到密钥。

## 一条完整流程

```powershell
# 1. 建项目
wf init --name "鲸鱼短片" --file D:\work\whale.json

# 2. 写剧本（会自动创建脚本节点）
wf script create --file D:\work\whale.json --title "鲸鱼短片" --script "第一幕：鲸鱼穿过星海。第二幕：它把星光带回深海。"

# 3. 拆镜头（本地填写，不调模型）
wf shots add --file D:\work\whale.json --title "开场" --prompt "夜空下的鲸鱼剪影" --duration 8
wf shots add --file D:\work\whale.json --title "入海" --prompt "星光坠入深海" --duration 4

# 4. 编译成任务节点
wf compile --file D:\work\whale.json --shots 1,2 --mode image

# 5. 检查
wf check --file D:\work\whale.json
wf info  --file D:\work\whale.json --pretty
```

产物是一个 `version:3` 的 WhaleFlow 项目文件，在桌面程序里打开就能看到画布和任务节点。

## 命令表

| 命令 | 作用 |
| --- | --- |
| `wf init --name <名称> [--file 路径]` | 新建空项目 |
| `wf info` | 节点数、类型分布、分镜数与当前修订 |
| `wf ls [--kind image]` | 列节点（id / 类型 / 标题 / 坐标 / 是否有结果） |
| `wf add <类型> --title T --content C [--x N --y N]` | 加节点；类型含 text、image、video、script、director、audio、shots、clip |
| `wf text <节点id> --content C` | 改节点正文 |
| `wf script create --node <id> --title T --script 正文` | 写入或更新剧本 |
| `wf shots ls` | 列镜头（序号、标题、时长、提示词） |
| `wf shots add --title T --prompt P [--duration 4\|8\|12] [--shot-size 中景] [--camera 固定]` | 加一个镜头 |
| `wf compile --shots 1,2 --mode image\|video` | 把镜头编译成待执行任务节点 |
| `wf check` | 结构校验 + 可读的提示（如镜头缺提示词） |
| `wf export --out 路径` | 导出带时间戳的项目副本 |

通用参数：`--file` 指定项目文件（默认 `whaleflow.project.json`），`--pretty` 输出缩进 JSON。

## 给 AI 代理的使用建议

1. **先 `wf info`**，确认项目里已有什么，别重复建。
2. **失败了看 `ok` 字段**：所有命令成功返回 `{"ok":true,...}`，失败返回 `{"ok":false,"error":"..."}` 并且退出码非 0。
3. **镜头编号是 1 开始的序号**（`shots ls` 里的 `index`），不是内部 id。
4. **`compile` 之后不要重复跑**：它会追加新节点。要重来就新建项目，或者在桌面里删掉旧任务节点。
5. **时长的合法值只有 4 / 8 / 12**，其他值会被夹到 4。
6. 你负责“写什么、分几个镜头、提示词怎么写”，**生成交给桌面程序**。

## 常见问题

**Q：`wf init` 报文件已存在？**
A：不会覆盖，这是故意的。换 `--file` 或先删掉旧文件。

**Q：编译出来的节点在桌面里看不到？**
A：桌面程序打开的是它自己的项目。用「项目 → 打开」选中 CLI 生成的 json 文件。

**Q：能不能让 CLI 直接出图？**
A：不能，原因见上。如果你要无人值守的全自动生成，需要自己在 CI 里带密钥直连模型服务，那是另一套东西，不在这个 CLI 里。

**Q：`wf` 命令本身不识别？**
A：`bin\wf.cmd` 只是包装，实际执行 `node bin/wf.mjs`。没加 PATH 时就用完整路径，或者把 `bin` 加进 PATH。
