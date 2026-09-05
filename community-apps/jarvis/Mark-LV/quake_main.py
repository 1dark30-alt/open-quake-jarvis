"""Open Quake entry point. Keep the upstream desktop entry point intact."""
import asyncio
import threading
from PyQt6.QtCore import QObject, pyqtSignal
from dashboard import server
from dashboard.quake import QuakeDashboard
server.DashboardServer = QuakeDashboard
from main import JarvisLive
from ui import JarvisUI

class Controls(QObject):
    mute = pyqtSignal()
    show = pyqtSignal()

def main():
    ui = JarvisUI('face.png')
    controls = Controls()
    controls.mute.connect(ui._win._toggle_mute)
    def show():
        ui._win.showNormal()
        ui._win.raise_()
        ui._win.activateWindow()
    controls.show.connect(show)
    QuakeDashboard.controls = controls
    def runner():
        ui.wait_for_api_key()
        asyncio.run(JarvisLive(ui).run())
    threading.Thread(target=runner, daemon=True).start()
    ui.root.mainloop()

if __name__ == '__main__':
    main()
