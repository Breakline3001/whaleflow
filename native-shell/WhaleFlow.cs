// Build as C# 5 / .NET Framework 4.8, WinExe x64. No Electron or host objects.
// References: System, System.Core, System.Drawing, System.Windows.Forms,
// System.Net.Http, System.Web.Extensions, Microsoft.Web.WebView2.Core/WinForms.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WhaleFlowNative
{
    internal static class Program
    {
        internal static int ExitCode;

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            NativeOptions options = null;
            bool smokeRequested = Array.Exists(args, delegate(string arg) { return arg == "--smoke-test" || arg.StartsWith("--smoke-screenshot=", StringComparison.Ordinal); });
            try
            {
                options = NativeOptions.Parse(args);
                Directory.CreateDirectory(options.DataPath);
                using (WhaleFlowWindow window = new WhaleFlowWindow(options))
                {
                    Application.Run(window);
                }
            }
            catch (Exception ex)
            {
                ExitCode = 1;
                string message = NativeLog.Redact(ex.ToString(), null);
                if (options == null)
                {
                    options = new NativeOptions();
                    options.Smoke = smokeRequested;
                    options.DataPath = Path.Combine(options.AppBase, "Data", smokeRequested ? "smoke-" + Guid.NewGuid().ToString("N") : "");
                }
                string data = options.DataPath;
                NativeLog.Write(data, message, null);
                if (!options.Smoke)
                    MessageBox.Show("WhaleFlow 无法启动。\r\n\r\n" + NativeLog.Redact(ex.Message, null) + "\r\n\r\n日志：" + Path.Combine(data, "native-startup.log"), "WhaleFlow", MessageBoxButtons.OK, MessageBoxIcon.Error);
                if (options != null && options.Smoke)
                {
                    try { SmokeReport.Write(options, false, message, null); }
                    catch (Exception reportError) { NativeLog.Write(data, reportError.ToString(), null); }
                }
            }
            Environment.ExitCode = ExitCode;
            return ExitCode;
        }
    }

    internal sealed class NativeOptions
    {
        internal readonly string AppBase = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        internal string DataPath;
        internal bool Smoke;
        internal string Screenshot;

        internal static NativeOptions Parse(string[] args)
        {
            NativeOptions result = new NativeOptions();
            // Identify smoke before parsing so invalid smoke arguments cannot show blocking dialogs.
            foreach (string arg in args) if (arg == "--smoke-test" || arg.StartsWith("--smoke-screenshot=", StringComparison.Ordinal)) result.Smoke = true;
            foreach (string arg in args)
            {
                if (arg == "--smoke-test") continue;
                if (arg.StartsWith("--smoke-screenshot=", StringComparison.Ordinal))
                {
                    string value = arg.Substring("--smoke-screenshot=".Length);
                    if (!Path.IsPathRooted(value) || !String.Equals(Path.GetExtension(value), ".png", StringComparison.OrdinalIgnoreCase))
                        throw new ArgumentException("--smoke-screenshot 必须是绝对 PNG 文件路径。");
                    result.Screenshot = Path.GetFullPath(value);
                }
                else throw new ArgumentException("未知启动参数：" + arg);
            }
            result.DataPath = Path.GetFullPath(Path.Combine(result.AppBase, "Data", result.Smoke ? "smoke-" + Guid.NewGuid().ToString("N") : ""));
            return result;
        }
    }

    internal static class NativeLog
    {
        private static readonly object secretLock = new object();
        private static readonly HashSet<string> knownSecrets = new HashSet<string>(StringComparer.Ordinal);
        internal static void RegisterSecrets(IEnumerable<string> values)
        {
            lock (secretLock) foreach (string value in values) if (!String.IsNullOrEmpty(value)) knownSecrets.Add(value);
        }
        internal static string Redact(string value, string session)
        {
            string text = value ?? "";
            if (!String.IsNullOrEmpty(session)) text = text.Replace(session, "[REDACTED]");
            string apiKey = Environment.GetEnvironmentVariable("WHALEFLOW_API_KEY");
            if (!String.IsNullOrEmpty(apiKey)) text = text.Replace(apiKey, "[REDACTED]");
            lock (secretLock) foreach (string secret in knownSecrets) text = text.Replace(secret, "[REDACTED]");
            return text;
        }

        internal static void Write(string dataPath, string message, string session)
        {
            try
            {
                Directory.CreateDirectory(dataPath);
                File.AppendAllText(Path.Combine(dataPath, "native-startup.log"), DateTime.UtcNow.ToString("o") + " " + Redact(message, session) + Environment.NewLine, new UTF8Encoding(false));
            }
            catch (Exception logError)
            {
                // A write failure must remain visible even when the deployment directory is read-only.
                Debug.WriteLine("WhaleFlow log write failed: " + Redact(logError.Message, session));
                Console.Error.WriteLine("WhaleFlow log write failed: " + Redact(logError.Message, session));
            }
        }
    }

    internal static class SmokeReport
    {
        internal static void Write(NativeOptions options, bool ok, object details, string screenshot)
        {
            string directory = Path.Combine(options.AppBase, "artifacts");
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, "native-smoke.json");
            Dictionary<string, object> report = new Dictionary<string, object>();
            report["ok"] = ok;
            report["details"] = details;
            report["timestamp"] = DateTime.UtcNow.ToString("o");
            report["dataPath"] = options.DataPath;
            report["screenshot"] = screenshot;
            File.WriteAllText(path, new JavaScriptSerializer().Serialize(report), new UTF8Encoding(false));
            Console.WriteLine("WHALEFLOW_NATIVE_SMOKE " + (ok ? "PASS" : "FAIL") + " " + path);
            Console.Out.Flush();
        }
    }

    internal sealed class WhaleFlowWindow : Form
    {
        private readonly NativeOptions options;
        private readonly WebView2 webView;
        // Bounded at 128 Mi characters, enough for the existing 100 MiB project limit plus RPC envelopes.
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 134217728, RecursionLimit = 100 };
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private readonly SemaphoreSlim dialogs = new SemaphoreSlim(1, 1);
        private readonly HashSet<string> pendingIds = new HashSet<string>(StringComparer.Ordinal);
        private readonly Queue<string> eventQueue = new Queue<string>();
        private readonly object eventLock = new object();
        private Process host;
        private HttpClient http;
        private ProtectedModelSettingsStore modelSettings;
        private HttpResponseMessage eventResponse;
        private Stream eventStream;
        private Task eventReader;
        private System.Windows.Forms.Timer smokeTimer;
        private string session;
        private string origin;
        private string currentPath;
        private string readyPath;
        private bool closing;
        private bool allowClose;
        private bool failed;
        private bool smokeFinishing;
        private bool smokeInjected;
        private bool eventDrainPending;
        private bool hostReady;
        private int smokeCredentialDialogs;
        // A controlled driver exists only for --smoke-test's isolated Data directory.
        // It exercises the actual native modal and store, not OS keyboard provenance.
        private void DriveSmokeCredentialDialog(Form dialog, TextBox input, Button apply, Button cancel)
        {
            int invocation = ++smokeCredentialDialogs;
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 120 };
            timer.Tick += delegate {
                timer.Stop(); timer.Dispose();
                if (dialog.IsDisposed) return;
                if (invocation == 1) cancel.PerformClick();
                else { input.Text = "controlled-native-modal-key-NOT-A-USER-KEY"; apply.PerformClick(); }
            };
            timer.Start();
        }

        internal WhaleFlowWindow(NativeOptions settings)
        {
            options = settings;
            Text = "WhaleFlow";
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            WindowState = FormWindowState.Maximized;
            Size = new Size(1512, 980);
            MinimumSize = new Size(1100, 700);
            BackColor = Color.FromArgb(17, 18, 24);
            ShowInTaskbar = !options.Smoke;
            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = BackColor;
            Controls.Add(webView);
            Shown += OnShown;
            FormClosing += OnClosing;
        }

        private async void OnShown(object sender, EventArgs e)
        {
            if (options.Smoke)
            {
                smokeTimer = new System.Windows.Forms.Timer();
                smokeTimer.Interval = 30000;
                smokeTimer.Tick += async delegate { await FinishSmokeAsync(false, "30 秒 smoke deadline 已到期。"); };
                smokeTimer.Start();
            }
            Exception startupError = null;
            try
            {
                await StartHostAsync();
                modelSettings = new ProtectedModelSettingsStore(options.DataPath, delegate(string method, object[] args) { return RpcAsync(method, args); }, NativeLog.RegisterSecrets, options.Smoke ? (Action<Form, TextBox, Button, Button>)DriveSmokeCredentialDialog : null);
                // Register every saved credential before the renderer can restore or write a project.
                await modelSettings.GetAsync();
                lifetime.Token.ThrowIfCancellationRequested();
                CoreWebView2Environment environment;
                try
                {
                    environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(options.DataPath, "webview"), null);
                    await webView.EnsureCoreWebView2Async(environment);
                }
                catch (WebView2RuntimeNotFoundException ex)
                {
                    throw new InvalidOperationException("未找到系统 Microsoft Edge WebView2 Runtime。请安装 Microsoft 官方 Evergreen WebView2 Runtime 后重试。", ex);
                }
                lifetime.Token.ThrowIfCancellationRequested();
                ConfigureWebView();
                // Headers must be flushed by the server immediately. Subscribe before React can run.
                await ConnectEventsAsync();
                lifetime.Token.ThrowIfCancellationRequested();
                if (eventReader.IsCompleted) throw new IOException("本地工作流事件连接在页面加载前已中断。");
                webView.CoreWebView2.Navigate(origin);
            }
            catch (OperationCanceledException) { if (!closing) startupError = new TimeoutException("本地引擎启动或事件连接超时。"); }
            catch (Exception ex) { startupError = ex; }
            if (startupError != null) await FailAsync(startupError);
        }

        private async Task StartHostAsync()
        {
            string nodePath = Path.Combine(options.AppBase, "host", "node.exe");
            string serverPath = Path.Combine(options.AppBase, "native-shell", "server.mjs");
            if (!File.Exists(nodePath)) throw new FileNotFoundException("缺少随应用分发的 host/node.exe；无需安装系统 Node，请完整解压应用。", nodePath);
            if (!File.Exists(serverPath)) throw new FileNotFoundException("缺少本地引擎 native-shell/server.mjs，请完整解压应用。", serverPath);
            Directory.CreateDirectory(options.DataPath);
            readyPath = Path.Combine(options.DataPath, "ready-" + Guid.NewGuid().ToString("N") + ".json");
            byte[] secret = new byte[32];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(secret);
            session = Convert.ToBase64String(secret);
            Array.Clear(secret, 0, secret.Length);
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = nodePath;
            start.Arguments = "native-shell/server.mjs";
            start.WorkingDirectory = options.AppBase;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = false;
            start.RedirectStandardError = false;
            start.EnvironmentVariables["WHALEFLOW_HOST_SESSION"] = session;
            start.EnvironmentVariables["WHALEFLOW_HOST_DATA"] = options.DataPath;
            start.EnvironmentVariables["WHALEFLOW_HOST_READY"] = readyPath;
            if (options.Smoke) start.EnvironmentVariables["WHALEFLOW_SMOKE"] = "1";
            else start.EnvironmentVariables.Remove("WHALEFLOW_SMOKE");
            // Never let ambient Node preload hooks alter the bundled, purpose-specific engine.
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            host = new Process();
            host.StartInfo = start;
            host.EnableRaisingEvents = true;
            host.Exited += OnHostExited;
            if (!host.Start()) throw new InvalidOperationException("无法启动随应用分发的本地 Node 引擎。");
            Stopwatch deadline = Stopwatch.StartNew();
            try
            {
                while (deadline.ElapsedMilliseconds < 8000)
                {
                    lifetime.Token.ThrowIfCancellationRequested();
                    if (host.HasExited) throw new InvalidOperationException("本地 Node 引擎在启动时退出，退出码 " + host.ExitCode + "。请检查部署内容及 native-startup.log。");
                    if (File.Exists(readyPath))
                    {
                        // The server should use atomic rename; tolerate an incomplete first write.
                        string text = null;
                        try { text = File.ReadAllText(readyPath, Encoding.UTF8); }
                        catch (IOException) { }
                        Dictionary<string, object> ready = null;
                        if (text != null)
                        {
                            try { ready = json.DeserializeObject(text) as Dictionary<string, object>; }
                            catch (ArgumentException) { }
                        }
                        if (ready != null)
                        {
                            object portObject;
                            int port;
                            if (ready.Count != 1 || !ready.TryGetValue("port", out portObject) || !(portObject is int) || !Int32.TryParse(Convert.ToString(portObject), out port) || port < 1 || port > 65535)
                                throw new InvalidDataException("本地引擎 ready 文件格式无效，必须仅包含有效 port。");
                            origin = "http://127.0.0.1:" + port + "/";
                            HttpClientHandler handler = new HttpClientHandler();
                            handler.UseProxy = false;
                            handler.AllowAutoRedirect = false;
                            handler.UseCookies = false;
                            http = new HttpClient(handler);
                            http.BaseAddress = new Uri(origin);
                            http.Timeout = Timeout.InfiniteTimeSpan;
                            hostReady = true;
                            return;
                        }
                    }
                    await Task.Delay(50, lifetime.Token);
                }
                throw new TimeoutException("本地引擎未在 8 秒内就绪。请检查 host/node.exe 和 native-shell/server.mjs。");
            }
            finally
            {
                try { if (File.Exists(readyPath)) File.Delete(readyPath); }
                catch (Exception ex) { Log("清理 ready 文件失败：" + ex.Message); }
            }
        }

        private void ConfigureWebView()
        {
            CoreWebView2 core = webView.CoreWebView2;
            CoreWebView2Settings settings = core.Settings;
            settings.IsScriptEnabled = true;
            settings.IsWebMessageEnabled = true;
            settings.AreHostObjectsAllowed = false;
            settings.AreDevToolsEnabled = false;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsStatusBarEnabled = false;
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { if (!IsRoot(e.Uri)) e.Cancel = true; };
            core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { if (!IsLocal(e.Uri)) e.Cancel = true; };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; e.Handled = true; };
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e)
            {
                e.State = e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead && e.IsUserInitiated && IsRoot(e.Uri)
                    ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                e.Handled = true;
            };
            core.WebMessageReceived += OnWebMessage;
            core.NavigationCompleted += OnNavigationCompleted;
            core.ProcessFailed += async delegate(object sender, CoreWebView2ProcessFailedEventArgs e)
            {
                await FailAsync(new InvalidOperationException("系统 WebView2 进程异常：" + e.ProcessFailedKind + "。"));
            };
        }

        private bool IsRoot(string value)
        {
            // Exact root URL, including no query, fragment, userinfo, or alternate host spelling.
            return origin != null && String.Equals(value, origin, StringComparison.Ordinal);
        }

        private bool IsLocal(string value)
        {
            Uri uri;
            Uri local;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) && Uri.TryCreate(origin, UriKind.Absolute, out local)
                && uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port == local.Port && uri.UserInfo.Length == 0;
        }

        private async Task ConnectEventsAsync()
        {
            using (CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
            using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Get, "events"))
            {
                deadline.CancelAfter(5000);
                request.Headers.Add("X-WhaleFlow-Session", session);
                eventResponse = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                eventResponse.EnsureSuccessStatusCode();
                if (eventResponse.Content.Headers.ContentType == null || eventResponse.Content.Headers.ContentType.MediaType != "text/event-stream")
                    throw new InvalidDataException("本地事件端点没有返回 text/event-stream。");
                eventStream = await eventResponse.Content.ReadAsStreamAsync();
                eventReader = Task.Run((Func<Task>)ReadEventsAsync);
            }
        }

        private async Task ReadEventsAsync()
        {
            try
            {
                using (StreamReader reader = new StreamReader(eventStream, Encoding.UTF8, true, 4096, true))
                {
                    StringBuilder data = new StringBuilder();
                    while (!lifetime.IsCancellationRequested)
                    {
                        string line = await reader.ReadLineAsync().ConfigureAwait(false);
                        if (line == null) throw new EndOfStreamException("本地工作流 SSE 事件连接已关闭。");
                        if (line.Length == 0)
                        {
                            if (data.Length > 0)
                            {
                                string payload = data.ToString();
                                data.Length = 0;
                                // Parse before forwarding: a malformed server event is a fatal protocol error.
                                object parsed = new JavaScriptSerializer { MaxJsonLength = 134217728, RecursionLimit = 100 }.DeserializeObject(payload);
                                if (!(parsed is Dictionary<string, object>)) throw new InvalidDataException("本地工作流事件不是 JSON 对象。");
                                QueueEvent("{\"event\":" + payload + "}");
                            }
                        }
                        else if (line.StartsWith("data:", StringComparison.Ordinal))
                        {
                            if (data.Length > 0) data.Append('\n');
                            data.Append(line.Substring(5).TrimStart(' '));
                            if (data.Length > 134217728) throw new InvalidDataException("本地工作流事件超过 128 Mi 字符上限。");
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                if (!lifetime.IsCancellationRequested && !closing)
                {
                    Log(ex.ToString());
                    Dispatch(async delegate { await FailAsync(new IOException("本地工作流事件连接中断：" + ex.Message, ex)); });
                }
            }
        }

        private void QueueEvent(string payload)
        {
            lock (eventLock)
            {
                eventQueue.Enqueue(payload);
                if (eventDrainPending) return;
                eventDrainPending = true;
            }
            Dispatch(DrainEvents);
        }

        private void DrainEvents()
        {
            if (closing) return;
            try
            {
                while (true)
                {
                    string payload;
                    lock (eventLock)
                    {
                        if (eventQueue.Count == 0) { eventDrainPending = false; return; }
                        payload = eventQueue.Dequeue();
                    }
                    webView.CoreWebView2.PostWebMessageAsJson(payload);
                }
            }
            catch (Exception ex) { Dispatch(async delegate { await FailAsync(ex); }); }
        }

        private void Dispatch(Action action)
        {
            if (closing || IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); }
            catch (InvalidOperationException ex) { if (!closing) Log(ex.ToString()); }
        }

        private async Task<object> RpcAsync(string method, object[] args, int milliseconds, CancellationToken cancel)
        {
            using (CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel))
            using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, "rpc"))
            {
                deadline.CancelAfter(milliseconds);
                request.Headers.Add("X-WhaleFlow-Session", session);
                request.Content = new StringContent(json.Serialize(new Dictionary<string, object> { { "method", method }, { "args", args } }), Encoding.UTF8, "application/json");
                using (HttpResponseMessage response = await http.SendAsync(request, HttpCompletionOption.ResponseContentRead, deadline.Token))
                {
                    string body = await response.Content.ReadAsStringAsync();
                    Dictionary<string, object> reply = json.DeserializeObject(body) as Dictionary<string, object>;
                    object error;
                    if (reply != null && reply.TryGetValue("error", out error))
                        throw new InvalidOperationException(NativeLog.Redact(Convert.ToString(error), session));
                    response.EnsureSuccessStatusCode();
                    object result;
                    if (reply == null || !reply.TryGetValue("result", out result)) throw new InvalidDataException("本地引擎 RPC 返回格式无效。");
                    return result;
                }
            }
        }

        private Task<object> RpcAsync(string method, params object[] args)
        {
            return RpcAsync(method, args, 15000, lifetime.Token);
        }

        private async void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (closing || !IsRoot(e.Source)) return;
            string id = null;
            bool registered = false;
            try
            {
                string text = e.WebMessageAsJson;
                StrictJson.Validate(text);
                Dictionary<string, object> message = json.DeserializeObject(text) as Dictionary<string, object>;
                object idObject, methodObject, argsObject;
                if (message == null || message.Count != 3 || !message.TryGetValue("id", out idObject) || !(idObject is string)
                    || !message.TryGetValue("method", out methodObject) || !(methodObject is string) || !message.TryGetValue("args", out argsObject))
                    throw new ArgumentException("桥接请求必须是 {id,method,args} JSON 对象。");
                id = (string)idObject;
                if (id.Length < 1 || id.Length > 160) { id = null; throw new ArgumentException("桥接请求 id 无效。"); }
                if (!pendingIds.Add(id)) { id = null; throw new ArgumentException("重复的桥接请求 id。"); }
                registered = true;
                object[] args = argsObject as object[];
                if (args == null) throw new ArgumentException("桥接 args 必须为 JSON 数组。");
                string method = (string)methodObject;
                if (method == "__smokeResult" && options.Smoke)
                {
                    Count(args, 1, 1);
                    Dictionary<string, object> result = args[0] as Dictionary<string, object>;
                    object ok, details;
                    if (result == null || !result.TryGetValue("ok", out ok) || !(ok is bool) || !result.TryGetValue("details", out details))
                        throw new ArgumentException("smoke 结果必须为 {ok,details}。");
                    await FinishSmokeAsync((bool)ok, details);
                    return;
                }
                object value = await CallDesktopAsync(method, args);
                Reply(id, "result", value);
            }
            catch (Exception ex)
            {
                string error = NativeLog.Redact(ex is OperationCanceledException ? "本地操作已取消或超时。" : ex.Message, session);
                Log("Bridge: " + error);
                if (id != null)
                {
                    ModelSettingsException modelError = ex as ModelSettingsException;
                    if (modelError == null) Reply(id, "error", error);
                    else Reply(id, "error", new Dictionary<string, object> { { "message", error }, { "code", modelError.Code }, { "currentRevision", modelError.CurrentRevision } });
                }
            }
            finally { if (registered) pendingIds.Remove(id); }
        }

        private void Reply(string id, string key, object value)
        {
            if (closing || webView.CoreWebView2 == null) return;
            try { webView.CoreWebView2.PostWebMessageAsJson(json.Serialize(new Dictionary<string, object> { { "id", id }, { key, value } })); }
            catch (Exception ex) { Log("Bridge reply: " + ex.Message); }
        }

        private static void Count(object[] args, int min, int max)
        {
            if (args.Length < min || args.Length > max) throw new ArgumentException("desktop 方法参数数量无效。");
        }

        private static void ObjectArgument(object value)
        {
            if (!(value is Dictionary<string, object>)) throw new ArgumentException("项目或配置必须是 JSON 对象。");
        }

        private async Task<object> CallDesktopAsync(string method, object[] args)
        {
            switch (method)
            {
                case "openProject":
                    Count(args, 0, 0);
                    return await OpenProjectAsync();
                case "saveProject":
                    Count(args, 1, 2);
                    ObjectArgument(args[0]);
                    if (args.Length == 2 && !(args[1] is bool)) throw new ArgumentException("saveAs 必须为布尔值。");
                    return await SaveProjectAsync(args[0], args.Length == 2 && (bool)args[1]);
                case "importMedia":
                    Count(args, 0, 0);
                    return await ImportMediaAsync();
                case "autosave":
                    Count(args, 1, 1); ObjectArgument(args[0]);
                    return await RpcAsync("project.autosave", args[0]);
                case "restoreAutosave":
                    Count(args, 0, 0);
                    return await RpcAsync("project.restore");
                case "runWorkflow":
                    Count(args, 2, 2); ObjectArgument(args[0]); ObjectArgument(args[1]);
                    Dictionary<string, object> selection = ProtectedModelSettingsStore.Map(args[1]);
                    object requestedRevision;
                    if (selection.Count != 1 || !selection.TryGetValue("settingsRevision", out requestedRevision)) throw new ArgumentException("运行只接受已保存的模型设置修订号。");
                    object runSnapshot = await modelSettings.RunSnapshotAsync(ProtectedModelSettingsStore.Revision(requestedRevision));
                    return await RpcAsync("workflow.runConfigured", args[0], runSnapshot);
                case "cancelWorkflow":
                    Count(args, 0, 0);
                    return await RpcAsync("workflow.cancel");
                case "getAppInfo":
                    Count(args, 0, 0);
                    return await RpcAsync("app.info");
                case "getModelSettings":
                    Count(args, 0, 0);
                    return await modelSettings.GetAsync();
                case "saveModelSettings":
                    Count(args, 1, 1); ObjectArgument(args[0]);
                    return await modelSettings.SaveAsync(args[0]);
                case "configureModelCredential":
                    Count(args, 3, 3);
                    if (!(args[0] is string) || ((string)args[0]).Length > 64 || !(args[2] is string)) throw new ArgumentException("凭据配置参数无效。");
                    await dialogs.WaitAsync(lifetime.Token);
                    try { return await modelSettings.ConfigureAsync(this, (string)args[0], ProtectedModelSettingsStore.Revision(args[1]), (string)args[2]); }
                    finally { dialogs.Release(); }
                case "listProviderModels":
                    Count(args, 1, 1); ObjectArgument(args[0]);
                    return await modelSettings.ListModelsAsync(args[0]);
                case "cancelProviderModels":
                    Count(args, 1, 1);
                    if (!(args[0] is string) || ((string)args[0]).Length > 200) throw new ArgumentException("模型列表请求编号无效。");
                    return await RpcAsync("models.cancel", args[0]);
                default:
                    throw new ArgumentException("不支持的 desktop 方法。");
            }
        }

        private async Task<object> OpenProjectAsync()
        {
            await dialogs.WaitAsync(lifetime.Token);
            try
            {
                if (closing) throw new OperationCanceledException();
                using (OpenFileDialog dialog = new OpenFileDialog())
                {
                    dialog.Title = "打开 WhaleFlow 项目";
                    dialog.Filter = "WhaleFlow 项目 (*.json;*.whaleflow)|*.json;*.whaleflow";
                    dialog.CheckFileExists = true;
                    dialog.Multiselect = false;
                    if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                    lifetime.Token.ThrowIfCancellationRequested();
                    string path = Path.GetFullPath(dialog.FileName);
                    object project = await RpcAsync("project.open", path);
                    currentPath = path;
                    return new Dictionary<string, object> { { "project", project }, { "filePath", path } };
                }
            }
            finally { dialogs.Release(); }
        }

        private async Task<object> SaveProjectAsync(object project, bool saveAs)
        {
            await dialogs.WaitAsync(lifetime.Token);
            try
            {
                if (closing) throw new OperationCanceledException();
                string path = currentPath;
                if (saveAs || String.IsNullOrEmpty(path))
                {
                    using (SaveFileDialog dialog = new SaveFileDialog())
                    {
                        dialog.Title = "保存 WhaleFlow 项目";
                        dialog.Filter = "WhaleFlow 项目 (*.whaleflow.json)|*.whaleflow.json|JSON 文件 (*.json)|*.json";
                        dialog.DefaultExt = "whaleflow.json";
                        dialog.AddExtension = true;
                        dialog.OverwritePrompt = true;
                        dialog.FileName = String.IsNullOrEmpty(path) ? "创意工作流.whaleflow.json" : Path.GetFileName(path);
                        if (!String.IsNullOrEmpty(path)) dialog.InitialDirectory = Path.GetDirectoryName(path);
                        if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                        path = Path.GetFullPath(dialog.FileName);
                    }
                }
                lifetime.Token.ThrowIfCancellationRequested();
                object result = await RpcAsync("project.save", path, project);
                currentPath = path;
                return result;
            }
            finally { dialogs.Release(); }
        }

        private async Task<object> ImportMediaAsync()
        {
            await dialogs.WaitAsync(lifetime.Token);
            try
            {
                if (closing) throw new OperationCanceledException();
                using (OpenFileDialog dialog = new OpenFileDialog())
                {
                    dialog.Title = "导入图片、视频或音频";
                    dialog.Filter = "图片、视频和音频|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.svg;*.bmp;*.avif;*.mp4;*.webm;*.mov;*.m4v;*.ogv;*.mp3;*.wav;*.ogg;*.m4a;*.flac|音频文件|*.mp3;*.wav;*.ogg;*.m4a;*.flac|所有文件|*.*";
                    dialog.CheckFileExists = true;
                    dialog.Multiselect = false;
                    if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                    lifetime.Token.ThrowIfCancellationRequested();
                    return await RpcAsync("media.import", Path.GetFullPath(dialog.FileName));
                }
            }
            finally { dialogs.Release(); }
        }

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (closing) return;
            if (!e.IsSuccess)
            {
                await FailAsync(new IOException("WhaleFlow 页面加载失败：" + e.WebErrorStatus));
                return;
            }
            if (!options.Smoke || smokeInjected || !IsRoot(webView.CoreWebView2.Source)) return;
            smokeInjected = true;
            Exception scriptError = null;
            try
            {
                // ExecuteScriptAsync resolves script evaluation, NOT an async JavaScript Promise.
                // The IIFE explicitly posts the final result through the smoke-only message method.
                await webView.CoreWebView2.ExecuteScriptAsync(SmokeScript);
            }
            catch (Exception ex) { scriptError = ex; }
            if (scriptError != null) await FinishSmokeAsync(false, NativeLog.Redact(scriptError.ToString(), session));
        }

        private async Task FinishSmokeAsync(bool ok, object details)
        {
            if (!options.Smoke || smokeFinishing || closing) return;
            smokeFinishing = true;
            if (smokeTimer != null) smokeTimer.Stop();
            string screenshot = null;
            try
            {
                if (!String.IsNullOrEmpty(options.Screenshot) && webView.CoreWebView2 != null)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(options.Screenshot));
                    // MemoryStream stays alive through capture. A hung capture cannot hold smoke open.
                    using (MemoryStream png = new MemoryStream())
                    {
                        Task capture = webView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, png);
                        if (await Task.WhenAny(capture, Task.Delay(3000)) != capture)
                        {
                            // Explicitly observe late faults; do not await a capture that exceeded its deadline.
                            Task ignoredLateCapture = capture.ContinueWith(delegate(Task task) { if (task.IsFaulted) Debug.WriteLine(task.Exception); }, TaskScheduler.Default);
                            throw new TimeoutException("WebView2 截图超过 3 秒 deadline。");
                        }
                        await capture;
                        File.WriteAllBytes(options.Screenshot, png.ToArray());
                    }
                    screenshot = options.Screenshot;
                }
                else if (!String.IsNullOrEmpty(options.Screenshot)) throw new InvalidOperationException("WebView2 未初始化，无法截图。");
                SmokeReport.Write(options, ok, details, screenshot);
            }
            catch (Exception ex)
            {
                ok = false;
                string message = NativeLog.Redact(ex.ToString(), session);
                Log(message);
                try { SmokeReport.Write(options, false, new Dictionary<string, object> { { "testDetails", details }, { "captureOrReportError", message } }, screenshot); }
                catch (Exception reportError) { Log(reportError.ToString()); Console.WriteLine("WHALEFLOW_NATIVE_SMOKE FAIL report-write-error"); }
            }
            Program.ExitCode = ok ? 0 : 1;
            await ShutdownAsync();
        }

        private async Task FailAsync(Exception ex)
        {
            if (closing || failed) return;
            failed = true;
            Program.ExitCode = 1;
            string message = NativeLog.Redact(ex.ToString(), session);
            Log(message);
            if (options.Smoke) { await FinishSmokeAsync(false, message); return; }
            MessageBox.Show(this, "WhaleFlow 无法继续运行。\r\n\r\n" + NativeLog.Redact(ex.Message, session) + "\r\n\r\n日志：" + Path.Combine(options.DataPath, "native-startup.log"), "WhaleFlow", MessageBoxButtons.OK, MessageBoxIcon.Error);
            await ShutdownAsync();
        }

        private void OnHostExited(object sender, EventArgs e)
        {
            if (closing || !hostReady) return;
            Dispatch(async delegate
            {
                if (!closing) await FailAsync(new IOException("本地 Node 引擎意外退出，退出码 " + host.ExitCode + "。"));
            });
        }

        private async void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (allowClose) return;
            e.Cancel = true;
            if (closing) return;
            if (options.Smoke && !smokeFinishing) await FinishSmokeAsync(false, "smoke 完成前窗口被关闭。");
            else await ShutdownAsync();
        }

        private async Task ShutdownAsync()
        {
            if (closing) return;
            closing = true;
            if (smokeTimer != null) smokeTimer.Stop();
            lifetime.Cancel();
            try { if (eventStream != null) eventStream.Dispose(); }
            catch (Exception ex) { Log("关闭 SSE 流失败：" + ex.Message); }
            try { if (eventResponse != null) eventResponse.Dispose(); }
            catch (Exception ex) { Log("关闭 SSE 响应失败：" + ex.Message); }
            if (host != null)
            {
                try
                {
                    if (!host.HasExited)
                    {
                        if (http != null)
                        {
                            try { await RpcAsync("host.shutdown", new object[0], 1200, CancellationToken.None); }
                            catch (Exception ex) { Log("本地引擎优雅关闭未完成：" + ex.Message); }
                        }
                        bool exited = await Task.Run(delegate { return host.WaitForExit(800); });
                        if (!exited)
                        {
                            // Only this Process instance: never enumerate/terminate system Node processes.
                            host.Kill();
                            await Task.Run(delegate { host.WaitForExit(800); });
                        }
                    }
                }
                catch (Exception ex) { Log("本地引擎退出处理：" + ex.Message); }
                finally { host.Exited -= OnHostExited; host.Dispose(); }
            }
            if (eventReader != null)
            {
                // Disposing the underlying stream unblocks ReadLineAsync on .NET Framework.
                await Task.WhenAny(eventReader, Task.Delay(300));
            }
            if (http != null) http.Dispose();
            try { webView.Dispose(); }
            catch (Exception ex) { Log("释放 WebView2 失败：" + ex.Message); }
            if (smokeTimer != null) smokeTimer.Dispose();
            allowClose = true;
            Close();
        }

        private void Log(string message) { NativeLog.Write(options.DataPath, message, session); }

        private const string SmokeScript = @"
(() => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, name, ms = 18000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(40); }
    throw new Error('Timed out: ' + name);
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  // Only click controls a user can actually reach; hidden menu copies are not valid targets.
  const clickable = element => {
    if (!element || !element.isConnected || element.matches(':disabled') ||
        element.getAttribute('aria-disabled') === 'true' || element.closest('[inert]')) return false;
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, 0), top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, innerWidth), bottom = Math.min(rect.bottom, innerHeight);
    if (right <= left || bottom <= top) return false;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return !!hit && (hit === element || element.contains(hit));
  };
  const findClickable = selector => Array.from(document.querySelectorAll(selector)).find(clickable);
  const projectMenuSelector = '[data-testid=""project-menu""]';
  const demoSelector = '[data-testid=""load-demo""]';
  const runLabelSelector = '[aria-label=""运行工作流""]';
  const runAllSelector = '[data-testid=""run-all""]';
  const openProjectMenu = async targetSelector => {
    if (!findClickable(targetSelector)) {
      const menu = await until(() => findClickable(projectMenuSelector), 'visible project menu');
      menu.click();
    }
    return await until(() => findClickable(targetSelector), 'visible project menu action: ' + targetSelector);
  };
  const report = result => window.chrome.webview.postMessage({id:'native-smoke-result',method:'__smokeResult',args:[result]});
  (async () => {
    const details = {checks:[], events:[]};
    let unsubscribe;
    try {
      await until(() => window.desktop && document.querySelector('[data-testid=""app-ready""]'), 'real app-ready DOM marker');
      details.initialNodeCount = document.querySelectorAll('.react-flow__node').length;
      assert(details.initialNodeCount === 0 && document.querySelectorAll('.workflow-node').length === 0, 'initial canvas must have zero nodes');
      details.checks.push('app-ready-and-empty-canvas');
       details.modelSettingsChecks = [];
       const bridgeKeys = ['openProject','saveProject','autosave','restoreAutosave','importMedia','runWorkflow','cancelWorkflow','getAppInfo','onWorkflowEvent','getModelSettings','saveModelSettings','configureModelCredential','listProviderModels','cancelProviderModels'].sort();
       assert(JSON.stringify(Object.keys(desktop).sort()) === JSON.stringify(bridgeKeys), 'native bridge must expose exactly fourteen members');
       details.modelSettingsChecks.push('exact-fourteen-native-bridge-members');
       const original = await desktop.getModelSettings();
       assert(original.revision === 0 && original.document.providers.length === 0, 'isolated smoke settings must start empty');
       const documentCopy = JSON.parse(JSON.stringify(original.document));
       documentCopy.providers.push({id:'native-smoke',name:'Native controlled service',protocol:'openai',baseUrl:'https://controlled.example/v1',auth:'required',allowInsecureHttpAuth:false,models:[{id:'same-model',name:'Controlled model',roles:['text']}]});
       documentCopy.defaults.text = {providerId:'native-smoke',modelId:'same-model'};
       const firstSave = await desktop.saveModelSettings({expectedRevision:0,document:documentCopy});
       assert(firstSave.revision === 1 && firstSave.document.providers.length === 1, 'native settings save/read failed');
       details.modelSettingsChecks.push('native-catalog-save-and-encrypted-readback');
       let conflicted = false;
       try { await desktop.saveModelSettings({expectedRevision:0,document:documentCopy}); }
       catch(error) { conflicted = error.code === 'REVISION_CONFLICT' && error.currentRevision === 1; }
       assert(conflicted, 'CAS conflict fields did not survive native bridge');
       details.modelSettingsChecks.push('structured-cas-conflict-preserves-current-revision');
       const cancelled = await desktop.configureModelCredential('native-smoke',1,'set');
       assert(cancelled.cancelled === true && cancelled.revision === 1 && !cancelled.credentials['native-smoke'].configured, 'native dialog cancel changed state');
       details.modelSettingsChecks.push('native-password-modal-cancel-unchanged');
       const keyed = await desktop.configureModelCredential('native-smoke',1,'set');
       assert(keyed.revision === 2 && keyed.credentials['native-smoke'].configured === true, 'native password modal save failed');
       assert(JSON.stringify(Object.keys(keyed.credentials['native-smoke']).sort()) === JSON.stringify(['configured','source']), 'native credential value leaked into public snapshot');
       const keyedReload = await desktop.getModelSettings();
       assert(keyedReload.revision === 2 && keyedReload.credentials['native-smoke'].configured, 'native key did not survive encrypted store reopen');
       details.modelSettingsChecks.push('native-password-modal-save-status-only-and-reopen');
       const cleared = await desktop.configureModelCredential('native-smoke',2,'clear');
       assert(cleared.revision === 3 && !cleared.credentials['native-smoke'].configured, 'native key clear failed');
       details.modelSettingsChecks.push('native-credential-clear');
       await desktop.configureModelCredential('native-smoke',3,'set');
       documentCopy.providers[0].baseUrl = 'https://changed.example/v1';
       const rebound = await desktop.saveModelSettings({expectedRevision:4,document:documentCopy});
       assert(rebound.revision === 5 && !rebound.credentials['native-smoke'].configured, 'endpoint change retained old key');
       details.modelSettingsChecks.push('native-endpoint-change-invalidates-credential-binding');
       const settingsButton = await until(() => findClickable('[aria-label=模型服务设置]'), 'model settings entry');
       settingsButton.click();
       await until(() => document.querySelector('[data-testid=model-settings-dialog]'), 'actual native model settings portal');
       const reloadSettings = await until(() => findClickable('[data-testid=settings-reload]'), 'settings reload');
       reloadSettings.click();
       await until(() => document.querySelector('[data-testid=settings-notice]')?.textContent.includes('已读取'), 'settings revision refresh through actual component');
       const closeSettings = await until(() => findClickable('[data-testid=settings-close]'), 'settings close');
       closeSettings.click();
       await until(() => !document.querySelector('[data-testid=model-settings-dialog]') && !document.querySelector('#root[inert]'), 'settings portal closed and canvas restored');
       details.modelSettingsChecks.push('actual-settings-component-reloads-native-snapshot');
       details.nativeModalScope = 'Actual WinForms modal and DPAPI store; controlled native test input/cancel driver, not physical OS keyboard input';
      const menu = await until(() => findClickable(projectMenuSelector), 'visible project menu');
      menu.click();
      const loadDemo = await until(() => findClickable(demoSelector), 'visible load-demo menu action');
      loadDemo.click();
      await until(() => document.querySelectorAll('.react-flow__node').length === 5 &&
        document.querySelectorAll('.workflow-node').length === 5, 'five demo workflow leaves');
      const expectedNodeIds = ['idea', 'writer', 'visual', 'result', 'memo'];
      const demoNodes = Array.from(document.querySelectorAll('.react-flow__node'));
      details.demoNodeIds = demoNodes.map(node => node.getAttribute('data-id'));
      assert(expectedNodeIds.every(id => demoNodes.some(node => node.getAttribute('data-id') === id && node.querySelector('.workflow-node'))),
        'demo must contain idea/writer/visual/result/memo workflow leaves');
      details.checks.push('project-menu-loads-five-node-demo');
      const info = await desktop.getAppInfo();
      assert(info && info.version === '0.4.0' && info.platform, 'getAppInfo must report version 0.4.0 and platform');
      details.appInfo = info;
      details.checks.push('desktop-getAppInfo');
      const successes = new Set();
      unsubscribe = desktop.onWorkflowEvent(event => {
        details.events.push({nodeId:event.nodeId,status:event.status,runId:event.runId});
        if (event.status === 'success' && expectedNodeIds.includes(event.nodeId)) successes.add(event.nodeId);
      });
      let runButton = findClickable(runLabelSelector);
      if (!runButton) runButton = await openProjectMenu(runAllSelector);
      assert(clickable(runButton), 'run action is not clickable');
      details.runAction = runButton.matches(runLabelSelector) ? 'aria-label' : 'project-menu-run-all';
      runButton.click();
      details.checks.push('visible-run-action-clicked');
      await until(() => successes.size === 5, 'five success SSE events');
      await until(() => document.querySelectorAll('.workflow-node.success').length === 5, 'five rendered success nodes');
      details.checks.push('five-success-events-and-nodes');
      const output = await until(() => document.querySelector('.kind-output .output-preview img'), 'output image');
      await output.decode();
      assert(output.complete && output.naturalWidth > 0 && output.naturalHeight > 0, 'output image did not decode');
      details.outputImage = {width:output.naturalWidth,height:output.naturalHeight};
      details.checks.push('output-image-decoded');
      // Menu actions may unmount after a click, so reacquire rather than checking a stale DOM node.
      if (!findClickable(runLabelSelector)) await openProjectMenu(runAllSelector);
      await until(() => {
        const button = findClickable(runLabelSelector) || findClickable(runAllSelector);
        return button && !button.classList.contains('is-running') && button.getAttribute('aria-busy') !== 'true' &&
          (button.getAttribute('aria-label') === '运行工作流' || button.matches(runAllSelector));
      }, 'run button reset');
      details.checks.push('run-button-reset');
      // Observe actual durable state: viewport fitting can restart the renderer's 850 ms debounce.
      // A fixed sleep races that animation and can report failure before the save is even sent.
      const saved = await until(async () => {
        const value = await desktop.restoreAutosave();
        details.autosaveObservation = {nodeCount:value?.nodes?.length || 0,
          outputs:value?.nodes?.filter(node => node.data?.lastOutput).length || 0};
        return value && value.version === 1 && value.nodes.length === 5 &&
          expectedNodeIds.every(id => value.nodes.some(node => node.id === id && node.data?.lastOutput)) ? value : null;
      }, 'durable renderer autosave with all five outputs');
      assert(saved && saved.version === 1 && saved.nodes.length === 5, 'renderer autosave not restored');
      const roundtrip = JSON.parse(JSON.stringify(saved));
      roundtrip.name = 'Native smoke roundtrip';
      await desktop.autosave(roundtrip);
      const restored = await desktop.restoreAutosave();
      assert(JSON.stringify(restored) === JSON.stringify(roundtrip), 'autosave/restore roundtrip differs');
      details.checks.push('autosave-restore-roundtrip');
      let rejected = false;
      try { await desktop.autosave({version:1,name:'invalid smoke project',nodes:[{}],edges:[]}); }
      catch (error) { rejected = true; details.invalidProjectError = String(error.message || error); }
      assert(rejected, 'invalid project was accepted');
      const stillValid = await desktop.restoreAutosave();
      assert(stillValid && stillValid.name === roundtrip.name && stillValid.nodes.length === 5, 'invalid project overwrote autosave');
      details.checks.push('invalid-project-rejected-without-overwrite');
      unsubscribe(); unsubscribe = null;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      report({ok:true,details});
    } catch (error) {
      if (unsubscribe) unsubscribe();
      details.error = String(error && (error.stack || error.message) || error);
      report({ok:false,details});
    }
  })();
})();";
    }

    // JavaScriptSerializer is intentionally used without a type resolver. Its legacy parser also
    // accepts some JavaScript literals; reject those first so the boundary accepts only normal JSON.
    internal sealed class StrictJson
    {
        private readonly string text;
        private int position;
        private StrictJson(string value) { text = value; }
        internal static void Validate(string text)
        {
            if (text == null || text.Length > 134217728) throw new ArgumentException("桥接 JSON 为空或超过 128 Mi 字符上限；项目自身仍限制为 100 MiB。");
            StrictJson parser = new StrictJson(text);
            parser.Value(0);
            parser.White();
            if (parser.position != text.Length) throw new ArgumentException("桥接消息包含非 JSON 内容。");
        }
        private void White()
        {
            while (position < text.Length && (text[position] == ' ' || text[position] == '\t' || text[position] == '\r' || text[position] == '\n')) position++;
        }
        private void Value(int depth)
        {
            if (depth > 95) throw new ArgumentException("桥接 JSON 嵌套过深。");
            White();
            if (position >= text.Length) Invalid();
            char c = text[position];
            if (c == '{')
            {
                position++; White();
                if (Take('}')) return;
                while (true)
                {
                    White(); String(); White(); Require(':'); Value(depth + 1); White();
                    if (Take('}')) return;
                    Require(',');
                }
            }
            if (c == '[')
            {
                position++; White();
                if (Take(']')) return;
                while (true) { Value(depth + 1); White(); if (Take(']')) return; Require(','); }
            }
            if (c == '"') { String(); return; }
            if (c == 't') { Literal("true"); return; }
            if (c == 'f') { Literal("false"); return; }
            if (c == 'n') { Literal("null"); return; }
            if (c == '-' || Digit(c)) { Number(); return; }
            Invalid();
        }
        private void String()
        {
            Require('"');
            while (position < text.Length)
            {
                char c = text[position++];
                if (c == '"') return;
                if (c < 32) Invalid();
                if (c != '\\') continue;
                if (position >= text.Length) Invalid();
                char escape = text[position++];
                if (escape == 'u')
                {
                    for (int i = 0; i < 4; i++)
                    {
                        if (position >= text.Length) Invalid();
                        char h = text[position++];
                        if (!(Digit(h) || (h >= 'a' && h <= 'f') || (h >= 'A' && h <= 'F'))) Invalid();
                    }
                }
                else if (escape != '"' && escape != '\\' && escape != '/' && escape != 'b' && escape != 'f' && escape != 'n' && escape != 'r' && escape != 't') Invalid();
            }
            Invalid();
        }
        private void Number()
        {
            Take('-');
            if (!Take('0'))
            {
                if (position >= text.Length || text[position] < '1' || text[position] > '9') Invalid();
                while (position < text.Length && Digit(text[position])) position++;
            }
            if (Take('.')) Digits();
            if (Take('e') || Take('E')) { if (!Take('+')) Take('-'); Digits(); }
        }
        private void Digits()
        {
            int start = position;
            while (position < text.Length && Digit(text[position])) position++;
            if (position == start) Invalid();
        }
        private void Literal(string value)
        {
            if (position + value.Length > text.Length || System.String.CompareOrdinal(text, position, value, 0, value.Length) != 0) Invalid();
            position += value.Length;
        }
        private bool Take(char value)
        {
            if (position >= text.Length || text[position] != value) return false;
            position++; return true;
        }
        private void Require(char value) { if (!Take(value)) Invalid(); }
        private static bool Digit(char value) { return value >= '0' && value <= '9'; }
        private static void Invalid() { throw new ArgumentException("桥接消息必须是普通 JSON。"); }
    }
}
