// Camera selection and opening.
//
// On macOS (and everywhere else) enumerateDevices() returns empty labels until
// the page has camera permission, so we ask for a throwaway stream first.

export const SIM_DEVICE_ID = 'sim';

let permissionPrimed = false;

async function primePermission() {
  if (permissionPrimed) return;
  const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  s.getTracks().forEach((t) => t.stop());
  permissionPrimed = true;
}

export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error('This browser has no mediaDevices API (are you on http://localhost?)');
  }
  let devices = await navigator.mediaDevices.enumerateDevices();
  const needsPermission = devices.some((d) => d.kind === 'videoinput' && !d.label);
  if (needsPermission) {
    await primePermission();
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

export async function openCamera(deviceId) {
  const video = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
