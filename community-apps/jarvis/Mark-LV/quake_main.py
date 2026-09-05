"""Open Quake entry point with selectable conversation providers."""
import asyncio
import threading
from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QMessageBox
from memory.config_manager import load_api_keys
from ui import JarvisUI

class Controls(QObject):
    mute = pyqtSignal()
    show = pyqtSignal()
    approval = pyqtSignal(object)

def main():
    ui = JarvisUI('face.png')
    controls = Controls()
    controls.mute.connect(ui._win._toggle_mute)
    def show():
        ui._win.showNormal()
        ui._win.raise_()
        ui._win.activateWindow()
    controls.show.connect(show)
    def approve(payload):
        params, future, loop = payload
        detail = params.get('command') or params.get('reason') or 'Apply the proposed file changes?'
        import json
        if not isinstance(detail, str):
            detail = json.dumps(detail, indent=2)
        show()
        accepted = QMessageBox.question(ui._win, 'JARVIS: approve action', detail,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No) == QMessageBox.StandardButton.Yes
        def resolve():
            if not future.done():
                future.set_result(accepted)
        loop.call_soon_threadsafe(resolve)
    controls.approval.connect(approve)
    from dashboard.quake import QuakeDashboard
    QuakeDashboard.controls = controls
    config = load_api_keys()
    if config.get('llm_provider', 'codex') == 'codex':
        from codex_runtime import CodexRuntime
        runtime = CodexRuntime(ui, controls)
        def runner():
            try:
                asyncio.run(runtime.run())
            except Exception as exc:
                ui.write_log('ERR: ' + str(exc))
        def stop():
            if hasattr(runtime, 'loop') and runtime.loop.is_running():
                runtime.loop.call_soon_threadsafe(runtime.stopping.set)
        ui._app.aboutToQuit.connect(stop)
    else:
        from dashboard import server
        server.DashboardServer = QuakeDashboard
        from main import JarvisLive
        def runner():
            ui.wait_for_api_key()
            asyncio.run(JarvisLive(ui).run())
    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    ui.root.mainloop()
    thread.join(timeout=5)

if __name__ == '__main__':
    main()
