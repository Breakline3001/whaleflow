// Controlled native-store contract tests. No real credentials, user data, or network.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using WhaleFlowNative;

internal static class ModelSettingsNativeTests
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly List<string> Checks = new List<string>();
    private const string Fake = "controlled-native-test-credential-NOT-A-USER-KEY";
    private static object Clone(object value) { return Json.DeserializeObject(Json.Serialize(value)); }
    private static Dictionary<string, object> Map(object value) { return (Dictionary<string, object>)value; }
    private static void Assert(bool condition, string name) { if (!condition) throw new Exception("Native model-store assertion failed: " + name); Checks.Add(name); }
    private static object DefaultDocument()
    {
        return Json.DeserializeObject("{\"version\":1,\"providers\":[],\"defaults\":{\"text\":null,\"image\":null,\"video\":null,\"audio\":null},\"general\":{\"temperature\":0.7,\"voice\":\"alloy\",\"restoreLastProject\":true}}");
    }
    private static Task<object> Transport(string method, object[] args)
    {
        if (method == "models.defaults") return Task.FromResult(DefaultDocument());
        if (method == "models.registerSecrets") return Task.FromResult<object>(null);
        if (method == "models.validate")
        {
            Dictionary<string, object> doc = Map(args[0]);
            if (doc.ContainsKey("rejectForTest")) throw new Exception("Controlled schema rejection");
            return Task.FromResult(Clone(doc));
        }
        throw new Exception("Unexpected private RPC in native store test");
    }
    private static ProtectedModelSettingsStore Store(string path)
    { return new ProtectedModelSettingsStore(path, Transport, delegate(IEnumerable<string> values) { foreach (string value in values) if (value != Fake) throw new Exception("Unexpected test secret"); }); }
    private static object SaveRequest(int revision, object document)
    { return new Dictionary<string, object> { { "expectedRevision", revision }, { "document", document } }; }
    private static async Task<bool> TryCas(ProtectedModelSettingsStore store, object document)
    {
        try { await store.SaveAsync(SaveRequest(2, document)); return true; }
        catch (ModelSettingsException error) { if (error.Code != "REVISION_CONFLICT" || error.CurrentRevision != 3) throw; return false; }
    }
    [STAThread]
    private static int Main()
    {
        try { Run().GetAwaiter().GetResult(); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error.ToString().Replace(Fake, "[CONTROLLED-TEST-SECRET]")); return 1; }
    }
    private static async Task Run()
    {
        string root = Path.Combine(Environment.CurrentDirectory, "artifacts", "model-store-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            ProtectedModelSettingsStore store = Store(root);
            Dictionary<string, object> initial = Map(await store.GetAsync());
            Assert((int)initial["revision"] == 0 && Map(initial["credentials"]).Count == 0, "fresh-empty-public-snapshot");
            Dictionary<string, object> document = Map(Clone(initial["document"]));
            document["providers"] = Json.DeserializeObject("[{\"id\":\"native-test\",\"name\":\"Controlled test\",\"protocol\":\"openai\",\"baseUrl\":\"https://a.example/v1\",\"auth\":\"required\",\"allowInsecureHttpAuth\":false,\"models\":[{\"id\":\"test-model\",\"name\":\"Test\",\"roles\":[\"text\"]}]}]");
            await store.SaveAsync(SaveRequest(0, document));
            Dictionary<string, object> configured = Map(await store.ApplyCredentialAsync("native-test", 1, Fake, false));
            Assert((int)configured["revision"] == 2 && (bool)Map(Map(configured["credentials"])["native-test"])["configured"], "native-key-write-status-only");
            Assert(!Json.Serialize(configured).Contains(Fake), "public-snapshot-never-contains-key");
            string vault = Path.Combine(root, "model-settings.dpapi");
            Assert(!Encoding.UTF8.GetString(File.ReadAllBytes(vault)).Contains(Fake), "persistent-document-is-dpapi-ciphertext");
            Dictionary<string, object> reopened = Map(await Store(root).GetAsync());
            Assert((int)reopened["revision"] == 2 && (bool)Map(Map(reopened["credentials"])["native-test"])["configured"], "new-store-reopens-current-user-dpapi");
            bool[] outcomes = await Task.WhenAll(TryCas(store, document), TryCas(Store(root), document));
            Assert(outcomes[0] != outcomes[1], "cross-instance-cas-only-one-writer");
            byte[] beforeRejected = File.ReadAllBytes(vault);
            Dictionary<string, object> bad = Map(Clone(document)); bad["rejectForTest"] = true;
            bool rejected = false;
            try { await store.SaveAsync(SaveRequest(3, bad)); } catch (Exception) { rejected = true; }
            Assert(rejected && Convert.ToBase64String(beforeRejected) == Convert.ToBase64String(File.ReadAllBytes(vault)), "validation-failure-does-not-replace-vault");
            Dictionary<string, object> changed = Map(Clone(document));
            Map(ProtectedModelSettingsStore.Items(changed["providers"])[0])["baseUrl"] = "https://b.example/v1";
            Dictionary<string, object> moved = Map(await store.SaveAsync(SaveRequest(3, changed)));
            Assert(!(bool)Map(Map(moved["credentials"])["native-test"])["configured"], "endpoint-change-removes-credential-binding");
            await store.ApplyCredentialAsync("native-test", 4, Fake, false);
            Dictionary<string, object> cleared = Map(await store.ApplyCredentialAsync("native-test", 5, null, true));
            Assert(!(bool)Map(Map(cleared["credentials"])["native-test"])["configured"], "explicit-clear-removes-only-owned-key");
            byte[] corrupted = new byte[] { 1, 7, 2, 9 };
            File.WriteAllBytes(vault, corrupted);
            bool unreadable = false;
            try { await store.GetAsync(); } catch (ModelSettingsException error) { unreadable = error.Code == "SETTINGS_UNREADABLE"; }
            Assert(unreadable && Convert.ToBase64String(corrupted) == Convert.ToBase64String(File.ReadAllBytes(vault)), "corrupt-vault-is-rejected-without-reset");
            string report = Path.Combine(Environment.CurrentDirectory, "artifacts", "model-settings-native.report.json");
            File.WriteAllText(report, Json.Serialize(new Dictionary<string, object> { { "ok", true }, { "checks", Checks }, { "scope", "Actual C# DPAPI and atomic/CAS storage; public schema transport is controlled; native password dialog NOT tested here" }, { "timestamp", DateTime.UtcNow.ToString("o") } }), new UTF8Encoding(false));
            Console.WriteLine("MODEL_SETTINGS_NATIVE_STORE PASS " + Checks.Count);
        }
        finally { Directory.Delete(root, true); }
    }
}
