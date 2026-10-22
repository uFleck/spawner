/// Windows job object that kills every assigned process when the hub exits,
/// so a crash cannot leave an orphaned IIS Express holding a port.
pub struct Job {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

unsafe impl Send for Job {}
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    pub fn new() -> Self {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Self { handle }
        }
    }

    pub fn assign(&self, process: std::os::windows::io::RawHandle) {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe {
            AssignProcessToJobObject(self.handle, process as _);
        }
    }
}

#[cfg(not(windows))]
impl Job {
    pub fn new() -> Self {
        Self {}
    }
}
