on run argv
  set targetPID to item 1 of argv as integer
  set menuLabel to item 2 of argv
  tell application "System Events"
    tell (first application process whose unix id is targetPID)
      set trayBar to last menu bar
      set icon to last menu bar item of trayBar
      click icon
      repeat 20 times
        if exists menu item menuLabel of menu 1 of icon then
          click menu item menuLabel of menu 1 of icon
          return
        end if
        delay 0.1
      end repeat
      error "Tray menu item unavailable"
    end tell
  end tell
end run
