//! Guest-side secret proxy.
//!
//! Listens on 127.0.0.1:9800 inside the VM and forwards HTTP requests
//! over vsock to the host-side secret proxy, which injects real API keys.
//!
//! This is a simple TCP-to-vsock bridge — no HTTP parsing is done here.
//! The host side does all the smart work (service routing, key injection).

#[cfg(target_os = "linux")]
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::net::TcpListener;
#[cfg(target_os = "linux")]
use std::os::fd::FromRawFd;

/// Port the guest proxy listens on inside the VM.
pub const GUEST_PROXY_PORT: u16 = 9800;

/// Start the guest-side proxy listener.
///
/// This runs in a background thread inside the VM agent.
/// It accepts TCP connections on localhost:9800 and bridges them
/// to the host via vsock port 6100.
#[cfg(target_os = "linux")]
pub fn start_guest_proxy() -> std::io::Result<()> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", GUEST_PROXY_PORT))?;

    eprintln!("[proxy] guest secret proxy listening on 127.0.0.1:{}", GUEST_PROXY_PORT);

    std::thread::Builder::new()
        .name("guest-proxy".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(tcp_stream) => {
                        std::thread::spawn(move || {
                            if let Err(e) = bridge_to_vsock(tcp_stream) {
                                eprintln!("[proxy] bridge error: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[proxy] accept error: {}", e);
                    }
                }
            }
        })?;

    Ok(())
}

/// Bridge a TCP connection to vsock.
///
/// Connects to the host via vsock CID 2, port 6100 (SECRET_PROXY),
/// then copies bytes bidirectionally.
#[cfg(target_os = "linux")]
fn bridge_to_vsock(mut tcp: std::net::TcpStream) -> std::io::Result<()> {
    use smolvm_protocol::ports;

    // Connect to host via vsock
    let mut vsock = vsock_connect(smolvm_protocol::cid::HOST, ports::SECRET_PROXY)?;

    // Copy TCP -> vsock (request) in current thread
    // Then copy vsock -> TCP (response)
    // We do this sequentially since HTTP is request-response
    let mut request_buf = Vec::new();
    // Read the full request with a timeout
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;

    // Read request data in chunks until we have the complete request
    let mut buf = [0u8; 8192];
    let mut headers_done = false;
    let mut content_length: usize = 0;
    let mut body_bytes_read: usize = 0;

    loop {
        match tcp.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                request_buf.extend_from_slice(&buf[..n]);

                if !headers_done {
                    // Check if we've received the full headers
                    if let Some(header_end) = find_header_end(&request_buf) {
                        headers_done = true;
                        // Parse content-length from headers
                        let header_str = String::from_utf8_lossy(&request_buf[..header_end]);
                        for line in header_str.lines() {
                            if let Some(cl) = line.strip_prefix("Content-Length: ")
                                .or_else(|| line.strip_prefix("content-length: "))
                            {
                                content_length = cl.trim().parse().unwrap_or(0);
                            }
                        }
                        body_bytes_read = request_buf.len() - header_end - 4; // 4 = "\r\n\r\n"
                        if body_bytes_read >= content_length {
                            break; // Got full request
                        }
                    }
                } else {
                    body_bytes_read += n;
                    if body_bytes_read >= content_length {
                        break; // Got full body
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if headers_done && body_bytes_read >= content_length {
                    break;
                }
                if request_buf.is_empty() {
                    return Err(e);
                }
                break;
            }
            Err(e) => return Err(e),
        }
    }

    // Send request to host via vsock
    vsock.write_all(&request_buf)?;
    vsock.flush()?;

    // Shutdown write side to signal request is complete
    // (vsock doesn't support shutdown, so we rely on the host reading until EOF)

    // Read response from vsock and forward to TCP
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(300)))?;
    loop {
        match vsock.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                tcp.write_all(&buf[..n])?;
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::BrokenPipe
                    || e.kind() == std::io::ErrorKind::ConnectionReset
                {
                    break;
                }
                return Err(e);
            }
        }
    }

    tcp.flush()?;
    Ok(())
}

/// Find the end of HTTP headers (\r\n\r\n) in a buffer.
#[cfg(target_os = "linux")]
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|w| w == b"\r\n\r\n")
}

/// Connect to a vsock endpoint (raw syscall).
#[cfg(target_os = "linux")]
fn vsock_connect(cid: u32, port: u32) -> std::io::Result<VsockStream> {
    use std::mem;

    const AF_VSOCK: libc::c_int = 40;

    #[repr(C)]
    struct sockaddr_vm {
        svm_family: libc::sa_family_t,
        svm_reserved1: u16,
        svm_port: u32,
        svm_cid: u32,
        svm_zero: [u8; 4],
    }

    unsafe {
        let fd = libc::socket(AF_VSOCK, libc::SOCK_STREAM, 0);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }

        let addr = sockaddr_vm {
            svm_family: AF_VSOCK as u16,
            svm_reserved1: 0,
            svm_port: port,
            svm_cid: cid,
            svm_zero: [0; 4],
        };

        if libc::connect(
            fd,
            &addr as *const sockaddr_vm as *const libc::sockaddr,
            mem::size_of::<sockaddr_vm>() as libc::socklen_t,
        ) < 0
        {
            libc::close(fd);
            return Err(std::io::Error::last_os_error());
        }

        Ok(VsockStream {
            fd: std::os::fd::OwnedFd::from_raw_fd(fd),
        })
    }
}

/// A vsock stream for client connections (connect, not accept).
#[cfg(target_os = "linux")]
struct VsockStream {
    fd: std::os::fd::OwnedFd,
}

#[cfg(target_os = "linux")]
impl Read for VsockStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        use std::os::fd::AsRawFd;
        unsafe {
            let n = libc::read(self.fd.as_raw_fd(), buf.as_mut_ptr() as *mut _, buf.len());
            if n < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl Write for VsockStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        use std::os::fd::AsRawFd;
        unsafe {
            let n = libc::write(self.fd.as_raw_fd(), buf.as_ptr() as *const _, buf.len());
            if n < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Stub for non-Linux platforms (agent only runs inside Linux VM).
#[cfg(not(target_os = "linux"))]
pub fn start_guest_proxy() -> std::io::Result<()> {
    Ok(()) // No-op on macOS (agent doesn't run here)
}
