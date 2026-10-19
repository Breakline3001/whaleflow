# 0.3 模型配置契约（实现前统一接口）

状态：实现中，未完成/未交付。基线从已验收0.2 source SHA9c90cb75405550ff372ac4eba45a80903a09b5ba6c4b6e1912b6bbc94341cb6d隔离解压。0.2源码、ZIP、桌面程序和用户Data不改。

## 参考事实
只读安装代码，不读 ~/.dsh 用户配置/密钥，不调用DSH实时API。实际Models为提供商行、一次展开一张编辑卡片、API凭据只写、折叠自定义设置/模型目录、添加提供商、明确应用/错误保留草稿。真实设置外壳800px宽、导航188px；README旧760x500已过期。DSH Models没有页面内设置默认模型；本程序四种生成角色默认值页是自身扩展，不冒称原位一致。不搬DSH插件系统/账号登录。

## 公开文档（纯JS双端验证）
`{version:1,providers:[],defaults:{text:null,image:null,video:null,audio:null},general:{temperature:0.7,voice:'alloy',restoreLastProject:true}}`
Provider：`{id,name,protocol:'openai'|'ollama',baseUrl,auth:'none'|'required',allowInsecureHttpAuth:false,models:[{id,name,roles:['text']} ]}`。
Selection：`{providerId,modelId}`，完整二元组或null。role text/image/video/audio；Ollama只允许text；OpenAI表示已经实现Chat Completions及按供应商实际支持的images/generations、audio/speech、videos，不提供未实现Responses/Anthropic选项。模型角色由用户声明，拉取列表不推断媒体能力。
边界：最多32providers、每provider256models、总512models；ID provider `[a-z][a-z0-9_-]{0,63}`，model实际ID非空≤200；name≤100；URL≤2000，无userinfo/query/hash，http(s)规范化去末尾slash；拒绝metadata/linklocal/unspecified IP，不破坏localhost/Ollama/LAN服务。带密钥的非loopback HTTP须显式allowInsecureHttpAuth。无任何key/ref/headers/secret字段进入公开文档，未知字段拒绝，不静默丢弃。提供商ID/模型ID唯一；默认选择必须存在且声明该role，同次删除默认引用须同时清除/替换。

## 桥与Native私有存储（父代理负责）
保留旧9成员，增加：
- `getModelSettings()` -> Snapshot
- `saveModelSettings({expectedRevision,document})` -> Snapshot
- `configureModelCredential(providerId,expectedRevision,action)` -> Snapshot；action set/clear。set打开C#原生密码输入框，密钥完全不进入React/浏览器/聊天；取消返回原快照并标cancelled:true，不改revision。
- `listProviderModels({providerId,expectedRevision,requestId})` -> `{requestId,settingsRevision,providerId,models:[{id,name}],source:'metadata'}`
- `cancelProviderModels(requestId)`。
Snapshot：`{revision,document,credentials:{[providerId]:{configured:boolean,source:'saved'|'none'} }}`。不回任何明文/密文/ref，不用“配置成功”代指供应商认证通过。
C#独占Data/model-settings.dpapi，DPAPI CurrentUser加密**整个**`{revision,document,credentials:{[id]:{protocol,baseUrl,value}}}`，同一文件原子替换（不分catalog/vault避免跨文件丢密钥）。所有get/save/configure在Semaphore串行，并跨进程独占model-settings.lock、每次重新读密文后做CAS；密钥对话框等待用户时不持有文件锁，提交时重验revision。新凭据是1到8192个ASCII打印字符（不含空白/控制字符），仅native输入，不能放入命令行。保存CAS检查expectedRevision，Node私有models.validate RPC返回规范document，保留同id且相同protocol+baseUrl的旧key；改地址/协议或auth none删除其绑定，必须重新配置。删除provider自动清本程序拥有的key。失败保持原文件/原revision，冲突code REVISION_CONFLICT携currentRevision。损坏密文报错不重置/覆盖。
配置dialog不读取/复制DSH现有key，不自动把旧WHALEFLOW_API_KEY分给任意新provider。新模型路径不使用env fallback。旧版保持原样，新版首次为离线示例。旧project节点provider/model字段可保留；真实执行必须映射已保存provider/目录，否则明确配置错误，不偷偷换端点。
C#启动/写新key时把会话内所有已知key注册给NativeLog和Node私有secret registry（只添加不移除，兼顾运行快照/旧key）。项目写入/输出/错误检查复用known secret+decoded media检查。密钥不进project/autosave/localStorage/日志/截图/报告/CLI/env。DPAPI不是抵御同用户恶意进程的隔离，跨Windows用户复制需重新录入。

## 私有Node接口与执行（父代理/后端实现协作）
私有RPC只供C#，不作为JS桥方法暴露：models.defaults()（返回全新空目录），models.validate(document)，models.list({provider,credential,requestId})，models.cancel(requestId)，models.registerSecrets(values)，workflow.runConfigured(project,runSnapshot)。
RunSnapshot：`{revision,document,credentials:{[providerId]:{protocol,baseUrl,value}}}`；服务端重新校验严格形状+binding，原子预留单运行锁、深拷贝选择/凭据，每节点解析自身provider+endpoint+model+key，再执行。传给外部请求不带workspace/其他画布/settings；正常SSE只输出runId/nodeId/status/output，绝不发内部snapshot。
App `runWorkflow(project,{settingsRevision})`，不发送endpoint/key/ref；C#按revision读取快照再转private workflow.runConfigured。新节点保存 `data.modelRef:{providerId,modelId}`；App语义失效名单加入modelRef。该执行语义使用项目version2（V3接收v1/v2，v1内非null modelRef明确拒绝，避免未知旧元数据在升级时意外激活；旧V2明确拒绝version2，不能静默忽略新字段）。
选型优先：手写/便签/输出/导入媒体不调用服务；明确data.provider=demo始终离线；否则modelRef优先，其次对应role默认；无providers且无ref可DEMO，已有providers却未选该role默认则报错。不认识的ref/被删provider仍可打开编辑但执行前无网络失败。旧节点特定model覆盖需在选定provider目录内存在，旧provider协议与目标provider不匹配则报错。DEMO载入不能改应用真实默认。
WorkflowEngine新增runConfigured或等价内部方案，旧executeWorkflow/run接口保留原测试，但配置路径无全局env回退。每节点config+apiKey隔离，所有响应/错误按整个会话known secret集合脱敏。不能只加UI下拉实际仍用全局endpoint。

## metadata与UI约定
只对**已保存**provider GET OpenAI /models 或Ollama /api/tags，redirect:error，10秒总超时，1MiB/512项上限，独立AbortController/requestId，不生成、不下载模型、不验证额度。不携带key到重定向/CDN，不调用WhaleFlow私有origin。失败/取消/过期revision不改目录；回候选后用户勾选角色/应用才保存。手填始终可用。
SettingsDialog独立新文件，800px宽/188px左导航、深色中性色、白色主按钮；通用/模型服务/默认模型/关于。props `{snapshot,onSnapshot,onClose,running}`，内部调用上述window.desktop方法，明确dirty/保存中/已保存/冲突/错误；失败保草稿。凭据按钮只调Native dialog，不做网页key输入。关闭/Escape有未保存确认，不让全局快捷键从设置中触发画布生成。一般参数temperature/voice/restoreLastProject必须真正使用，不加无效偏好控件。

## 必须验证
纯schema/边界/未知字段/secret禁止/默认引用、不同provider同名模型路由不同endpoint与不同key、缺key无env回退、地址改动失绑定、运行期间修改不影响快照、错误/二进制不泄key；metadata只GET/取消/超时/大body/重定向/错误不改目录；C#DPAPI原生dialog取消/更新/重开/CAS/损坏不覆盖；实际鼠标键盘添加编辑provider/model/default并重开确认，旧画布与v1导入不回归；Native/WebMessage/Node真实流程与最终解压包复验。
