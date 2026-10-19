param([int]$X,[int]$Y)
Add-Type @"
using System.Runtime.InteropServices;
public class CreatorMouse {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,System.UIntPtr e);
}
"@
[CreatorMouse]::SetProcessDPIAware() | Out-Null
if (-not [CreatorMouse]::SetCursorPos($X,$Y)) { throw "Native input desktop unavailable: SetCursorPos failed. Unlock/reconnect the Windows desktop and rerun overlay proof." }
[CreatorMouse]::mouse_event(2,0,0,0,[System.UIntPtr]::Zero)
[CreatorMouse]::mouse_event(4,0,0,0,[System.UIntPtr]::Zero)
