using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct WallCheckPropertyKey
{
    public Guid fmtid;
    public uint pid;
    public WallCheckPropertyKey(Guid guid, uint propertyId)
    {
        fmtid = guid;
        pid = propertyId;
    }
}

[StructLayout(LayoutKind.Explicit)]
public struct WallCheckPropVariant
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pwszVal;
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
public interface IWallCheckPropertyStore
{
    uint GetCount();
    void GetAt(uint index, out WallCheckPropertyKey key);
    void GetValue(ref WallCheckPropertyKey key, out WallCheckPropVariant value);
    void SetValue(ref WallCheckPropertyKey key, ref WallCheckPropVariant value);
    void Commit();
}

public static class WallCheckShortcutAppId
{
    private const uint ReadWrite = 0x2;
    private const ushort VtLPWStr = 31;
    private static readonly Guid AppIdPropertyGuid =
        new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
    private static extern void SHGetPropertyStoreFromParsingName(
        string path, IntPtr bindContext, uint flags, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IWallCheckPropertyStore store);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref WallCheckPropVariant value);

    public static void SetAppId(string shortcutFile, string appId)
    {
        if (string.IsNullOrWhiteSpace(shortcutFile) ||
            string.IsNullOrWhiteSpace(appId)) throw new ArgumentException("path/app ID missing");
        Guid iid = typeof(IWallCheckPropertyStore).GUID;
        IWallCheckPropertyStore store = null;
        SHGetPropertyStoreFromParsingName(shortcutFile, IntPtr.Zero, ReadWrite, ref iid, out store);
        if (store == null) throw new COMException("Unable to open shortcut property store");
        var key = new WallCheckPropertyKey(AppIdPropertyGuid, 5);
        var value = new WallCheckPropVariant { vt = VtLPWStr,
            pwszVal = Marshal.StringToCoTaskMemUni(appId) };
        try
        {
            store.SetValue(ref key, ref value);
            store.Commit();
        }
        finally
        {
            Marshal.FreeCoTaskMem(value.pwszVal);
            Marshal.ReleaseComObject(store);
        }
    }

}
