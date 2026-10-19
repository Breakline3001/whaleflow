// Native-owned model settings. The WebView receives public metadata only.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace WhaleFlowNative
{
    internal sealed class ModelSettingsException : Exception
    {
        internal readonly string Code;
        internal readonly int CurrentRevision;
        internal ModelSettingsException(string code, string message, int revision = -1) : base(message)
        { Code = code; CurrentRevision = revision; }
    }

    internal sealed class ProtectedModelSettingsStore
    {
        private const int MaximumBytes = 4 * 1024 * 1024;
        private readonly string directory;
        private readonly string file;
        private readonly Func<string, object[], Task<object>> rpc;
        private readonly Action<IEnumerable<string>> rememberSecrets;
        private readonly Action<Form, TextBox, Button, Button> dialogDriver;
        private readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = MaximumBytes, RecursionLimit = 40 };
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("WhaleFlow:ModelSettings:DPAPI:v1");

        internal ProtectedModelSettingsStore(string dataDirectory, Func<string, object[], Task<object>> transport, Action<IEnumerable<string>> remember, Action<Form, TextBox, Button, Button> smokeDialogDriver = null)
        {
            directory = Path.GetFullPath(dataDirectory);
            file = Path.Combine(directory, "model-settings.dpapi");
            rpc = transport;
            rememberSecrets = remember;
            dialogDriver = smokeDialogDriver;
        }

        internal static Dictionary<string, object> Map(object value)
        {
            Dictionary<string, object> result = value as Dictionary<string, object>;
            if (result == null) throw new ModelSettingsException("INVALID_SETTINGS", "模型配置对象无效。");
            return result;
        }
        internal static object[] Items(object value)
        {
            object[] array = value as object[];
            if (array != null) return array;
            ArrayList list = value as ArrayList;
            if (list != null) return list.ToArray();
            throw new ModelSettingsException("INVALID_SETTINGS", "模型配置列表无效。");
        }
        internal static int Revision(object value)
        {
            if (!(value is int) || (int)value < 0)
                throw new ModelSettingsException("INVALID_SETTINGS", "配置修订号无效。");
            return (int)value;
        }
        private object Copy(object value) { return json.DeserializeObject(json.Serialize(value)); }
        private static object Field(Dictionary<string, object> value, string name)
        {
            object field;
            if (!value.TryGetValue(name, out field)) throw new ModelSettingsException("INVALID_SETTINGS", "模型配置缺少必需字段。");
            return field;
        }
        private static string Text(Dictionary<string, object> value, string name)
        {
            object field = Field(value, name);
            if (!(field is string)) throw new ModelSettingsException("INVALID_SETTINGS", "模型配置文本无效。");
            return (string)field;
        }
        private static Dictionary<string, object> Provider(Dictionary<string, object> state, string id)
        {
            foreach (object item in Items(Field(Map(Field(state, "document")), "providers")))
            {
                Dictionary<string, object> provider = Map(item);
                if (String.Equals(Text(provider, "id"), id, StringComparison.Ordinal)) return provider;
            }
            throw new ModelSettingsException("PROVIDER_NOT_FOUND", "该提供商已被删除，请重新打开设置。");
        }
        private static bool SameBinding(Dictionary<string, object> provider, Dictionary<string, object> credential)
        {
            return String.Equals(Text(provider, "protocol"), Text(credential, "protocol"), StringComparison.Ordinal)
                && String.Equals(Text(provider, "baseUrl"), Text(credential, "baseUrl"), StringComparison.Ordinal);
        }
        private static int NextRevision(int current)
        {
            if (current == Int32.MaxValue) throw new ModelSettingsException("REVISION_LIMIT", "配置修订号已达上限，未更改已保存数据。");
            return current + 1;
        }
        private static void CompareRevision(Dictionary<string, object> state, int expected)
        {
            int current = Revision(Field(state, "revision"));
            if (current != expected) throw new ModelSettingsException("REVISION_CONFLICT", "模型配置已在别处修改。草稿已保留，请重新载入后再应用。", current);
        }

        private async Task<FileStream> AcquireFileLockAsync()
        {
            Directory.CreateDirectory(directory);
            DateTime end = DateTime.UtcNow.AddSeconds(5);
            while (true)
            {
                try { return new FileStream(Path.Combine(directory, "model-settings.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
                catch (IOException)
                {
                    if (DateTime.UtcNow >= end) throw new ModelSettingsException("SETTINGS_BUSY", "另一窗口正在保存模型设置，请稍后重试。");
                }
                await Task.Delay(40);
            }
        }

        private async Task<Dictionary<string, object>> ReadAsync()
        {
            Dictionary<string, object> state;
            if (!File.Exists(file))
            {
                object defaults = await rpc("models.defaults", new object[0]);
                return new Dictionary<string, object> { { "revision", 0 }, { "document", defaults }, { "credentials", new Dictionary<string, object>() } };
            }
            byte[] protectedBytes = null;
            byte[] plain = null;
            try
            {
                if (new FileInfo(file).Length > MaximumBytes) throw new InvalidDataException();
                protectedBytes = File.ReadAllBytes(file);
                plain = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.CurrentUser);
                if (plain.Length > MaximumBytes) throw new InvalidDataException();
                state = Map(json.DeserializeObject(new UTF8Encoding(false, true).GetString(plain)));
                if (state.Count != 3) throw new InvalidDataException();
                Revision(Field(state, "revision"));
                Map(Field(state, "document"));
                Dictionary<string, object> credentials = Map(Field(state, "credentials"));
                if (credentials.Count > 32) throw new InvalidDataException();
                List<string> values = new List<string>();
                foreach (KeyValuePair<string, object> entry in credentials)
                {
                    Dictionary<string, object> credential = Map(entry.Value);
                    if (credential.Count != 3) throw new InvalidDataException();
                    string value = Text(credential, "value");
                    ValidateCredential(value);
                    values.Add(value);
                }
                rememberSecrets(values);
                await rpc("models.registerSecrets", new object[] { values.ToArray() });
                state["document"] = await rpc("models.validate", new object[] { state["document"] });
                foreach (KeyValuePair<string, object> entry in credentials)
                {
                    Dictionary<string, object> provider = Provider(state, entry.Key);
                    if (Text(provider, "auth") != "required" || !SameBinding(provider, Map(entry.Value))) throw new InvalidDataException();
                }
                return state;
            }
            catch (Exception)
            {
                // Do not echo decrypted JSON, even when a parser or provider rejects it.
                throw new ModelSettingsException("SETTINGS_UNREADABLE", "无法读取本机加密模型配置。文件已保留，未重置或覆盖；跨 Windows 用户迁移需重新配置。");
            }
            finally
            {
                if (plain != null) Array.Clear(plain, 0, plain.Length);
                if (protectedBytes != null) Array.Clear(protectedBytes, 0, protectedBytes.Length);
            }
        }

        private void Write(Dictionary<string, object> state)
        {
            byte[] plain = Encoding.UTF8.GetBytes(json.Serialize(state));
            byte[] encrypted = null;
            string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                if (plain.Length > MaximumBytes - 65536) throw new ModelSettingsException("SETTINGS_TOO_LARGE", "模型配置超过大小限制。");
                encrypted = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
                if (encrypted.Length > MaximumBytes) throw new ModelSettingsException("SETTINGS_TOO_LARGE", "模型配置超过大小限制。");
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                { stream.Write(encrypted, 0, encrypted.Length); stream.Flush(true); }
                if (File.Exists(file)) File.Replace(temporary, file, null);
                else File.Move(temporary, file);
            }
            finally
            {
                Array.Clear(plain, 0, plain.Length);
                if (encrypted != null) Array.Clear(encrypted, 0, encrypted.Length);
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }

        private object PublicSnapshot(Dictionary<string, object> state, bool cancelled = false)
        {
            Dictionary<string, object> metadata = new Dictionary<string, object>();
            Dictionary<string, object> credentials = Map(state["credentials"]);
            foreach (object item in Items(Field(Map(state["document"]), "providers")))
            {
                Dictionary<string, object> provider = Map(item);
                string id = Text(provider, "id");
                bool configured = credentials.ContainsKey(id) && Text(provider, "auth") == "required" && SameBinding(provider, Map(credentials[id]));
                metadata[id] = new Dictionary<string, object> { { "configured", configured }, { "source", configured ? "saved" : "none" } };
            }
            Dictionary<string, object> result = new Dictionary<string, object> { { "revision", state["revision"] }, { "document", Copy(state["document"]) }, { "credentials", metadata } };
            if (cancelled) result["cancelled"] = true;
            return result;
        }

        internal async Task<object> GetAsync()
        {
            await gate.WaitAsync();
            try { using (await AcquireFileLockAsync()) { return PublicSnapshot(await ReadAsync()); } }
            finally { gate.Release(); }
        }

        internal async Task<object> SaveAsync(object request)
        {
            Dictionary<string, object> input = Map(request);
            if (input.Count != 2) throw new ModelSettingsException("INVALID_SETTINGS", "应用设置只接受修订号与公开配置。");
            int expected = Revision(Field(input, "expectedRevision"));
            object document = Field(input, "document");
            if (json.Serialize(document).Length > MaximumBytes / 2) throw new ModelSettingsException("SETTINGS_TOO_LARGE", "模型配置超过大小限制。");
            await gate.WaitAsync();
            try
            {
                using (await AcquireFileLockAsync())
                {
                    Dictionary<string, object> old = await ReadAsync();
                    CompareRevision(old, expected);
                    object canonical = await rpc("models.validate", new object[] { document });
                    Dictionary<string, object> retained = new Dictionary<string, object>();
                    Dictionary<string, object> oldCredentials = Map(old["credentials"]);
                    foreach (object item in Items(Field(Map(canonical), "providers")))
                    {
                        Dictionary<string, object> provider = Map(item);
                        string id = Text(provider, "id");
                        object credential;
                        if (Text(provider, "auth") == "required" && oldCredentials.TryGetValue(id, out credential) && SameBinding(provider, Map(credential))) retained[id] = Copy(credential);
                    }
                    Dictionary<string, object> next = new Dictionary<string, object> { { "revision", NextRevision(expected) }, { "document", canonical }, { "credentials", retained } };
                    Write(next);
                    return PublicSnapshot(next);
                }
            }
            finally { gate.Release(); }
        }

        private static void ValidateCredential(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Length > 8192)
                throw new ModelSettingsException("INVALID_CREDENTIAL", "密钥不能为空，且不能超过 8192 字符。");
            foreach (char character in value)
                if (character < 0x21 || character > 0x7e) throw new ModelSettingsException("INVALID_CREDENTIAL", "密钥不能包含空白、控制字符或非 ASCII 字符。");
        }

        // Used by the native dialog; no bridge accepts this plaintext value.
        internal async Task<object> ApplyCredentialAsync(string providerId, int expectedRevision, string value, bool clear)
        {
            if (!clear)
            {
                ValidateCredential(value);
                rememberSecrets(new string[] { value });
                await rpc("models.registerSecrets", new object[] { new string[] { value } });
            }
            await gate.WaitAsync();
            try
            {
                using (await AcquireFileLockAsync())
                {
                    Dictionary<string, object> state = await ReadAsync();
                    CompareRevision(state, expectedRevision);
                    Dictionary<string, object> provider = Provider(state, providerId);
                    Dictionary<string, object> credentials = Map(state["credentials"]);
                    if (clear) credentials.Remove(providerId);
                    else
                    {
                        if (Text(provider, "auth") != "required") throw new ModelSettingsException("CREDENTIAL_NOT_REQUIRED", "请先将此提供商设为需要密钥并应用设置。");
                        credentials[providerId] = new Dictionary<string, object> { { "protocol", provider["protocol"] }, { "baseUrl", provider["baseUrl"] }, { "value", value } };
                    }
                    state["revision"] = NextRevision(expectedRevision);
                    Write(state);
                    return PublicSnapshot(state);
                }
            }
            finally { gate.Release(); }
        }

        internal async Task<object> ConfigureAsync(IWin32Window owner, string providerId, int expectedRevision, string action)
        {
            if (action != "set" && action != "clear") throw new ModelSettingsException("INVALID_SETTINGS", "凭据操作无效。");
            if (action == "clear") return await ApplyCredentialAsync(providerId, expectedRevision, null, true);
            Dictionary<string, object> snapshot = Map(await GetAsync());
            CompareRevision(snapshot, expectedRevision);
            Dictionary<string, object> provider = Provider(snapshot, providerId);
            if (Text(provider, "auth") != "required") throw new ModelSettingsException("CREDENTIAL_NOT_REQUIRED", "请先将此提供商设为需要密钥并应用设置。");
            using (Form dialog = new Form())
            using (TextBox input = new TextBox())
            using (Button apply = new Button())
            using (Button cancel = new Button())
            {
                dialog.Text = "配置模型服务密钥";
                dialog.StartPosition = FormStartPosition.CenterParent;
                dialog.FormBorderStyle = FormBorderStyle.FixedDialog;
                dialog.MinimizeBox = false; dialog.MaximizeBox = false; dialog.ShowInTaskbar = false;
                dialog.ClientSize = new Size(510, 236);
                dialog.AutoScaleMode = AutoScaleMode.Dpi;
                Label title = new Label { Text = Text(provider, "name"), AutoEllipsis = true, Location = new Point(22, 18), Size = new Size(466, 24) };
                Label address = new Label { Text = Text(provider, "baseUrl"), AutoEllipsis = true, Location = new Point(22, 47), Size = new Size(466, 24) };
                input.Location = new Point(22, 83); input.Size = new Size(466, 27); input.UseSystemPasswordChar = true; input.MaxLength = 8192;
                Label note = new Label { Text = "密钥仅供当前提供商使用，按当前 Windows 用户加密保存。\r\n不会回显到网页、项目或导出文件；取消不更改设置。", Location = new Point(22, 122), Size = new Size(466, 46) };
                apply.Text = "保存密钥"; apply.Location = new Point(294, 184); apply.Size = new Size(94, 32); apply.DialogResult = DialogResult.OK;
                cancel.Text = "取消"; cancel.Location = new Point(396, 184); cancel.Size = new Size(92, 32); cancel.DialogResult = DialogResult.Cancel;
                dialog.Controls.AddRange(new Control[] { title, address, input, note, apply, cancel });
                dialog.AcceptButton = apply; dialog.CancelButton = cancel;
                dialog.Shown += delegate { input.Focus(); if (dialogDriver != null) dialogDriver(dialog, input, apply, cancel); };
                if (dialog.ShowDialog(owner) != DialogResult.OK) { snapshot["cancelled"] = true; return snapshot; }
                string value = input.Text.Trim(); input.Clear();
                return await ApplyCredentialAsync(providerId, expectedRevision, value, false);
            }
        }

        internal async Task<object> RunSnapshotAsync(int expectedRevision)
        {
            await gate.WaitAsync();
            try
            {
                using (await AcquireFileLockAsync())
                {
                    Dictionary<string, object> state = await ReadAsync();
                    CompareRevision(state, expectedRevision);
                    return Copy(state);
                }
            }
            finally { gate.Release(); }
        }

        internal async Task<object> ListModelsAsync(object request)
        {
            Dictionary<string, object> input = Map(request);
            if (input.Count != 3) throw new ModelSettingsException("INVALID_SETTINGS", "模型列表请求字段无效。");
            int expected = Revision(Field(input, "expectedRevision"));
            string providerId = Text(input, "providerId");
            string requestId = Text(input, "requestId");
            Dictionary<string, object> state = Map(await RunSnapshotAsync(expected));
            Dictionary<string, object> provider = Provider(state, providerId);
            object credential;
            Map(state["credentials"]).TryGetValue(providerId, out credential);
            object result = await rpc("models.list", new object[] { new Dictionary<string, object> { { "provider", provider }, { "credential", credential }, { "requestId", requestId } } });
            Dictionary<string, object> response = Map(result);
            response["settingsRevision"] = expected;
            response["providerId"] = providerId;
            return response;
        }
    }
}
