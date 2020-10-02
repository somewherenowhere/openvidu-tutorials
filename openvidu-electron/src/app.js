const ipcRenderer = require('electron').ipcRenderer;
const BrowserWindow = require('electron').remote.BrowserWindow;

var openvidu;
var session;
var publisher;
var mySessionId;

const global = {
    pcSend: null,
    pcRecv: null,
    statsInterval: null,

    // Memory used to calculate averages and rates.
    printWebRtcStats: { bytesSent: 0 },
  };

  // HTML UI elements
  // ================

  const ui = {
    // Inputs
    start: document.getElementById("uiStart"),
    stop: document.getElementById("uiStop"),

    // Video
    localVideo: document.getElementById("uiLocalVideo"),
    remoteVideo: document.getElementById("uiRemoteVideo"),

    // Debug
    console: document.getElementById("uiConsole"),
  };


//   ui.start.addEventListener("click", startWebrtc);
// ui.stop.addEventListener("click", stopWebrtc);
// ui.stop.disabled = true;

window.addEventListener("load", () => {
  console.log("[on window.load] Page loaded");

  if ("adapter" in window) {
    console.log(
      // eslint-disable-next-line no-undef
      `[on window.load] webrtc-adapter loaded, browser: '${adapter.browserDetails.browser}', version: '${adapter.browserDetails.version}'`
    );
  } else {
    console.warn(
      "[on window.load] webrtc-adapter is not loaded! an install or config issue?"
    );
  }
});

window.addEventListener("beforeunload", () => {
  console.log("[on window.beforeunload] Page unloading");
});

// Send all logs to both console and UI.
{
  const logMethod = console.log;
  const logMessages = [];

  console.log = function () {
    logMessages.push.apply(logMessages, arguments);
    const console = document.getElementById("uiConsole");
    console.innerHTML = logMessages.reduce(
      (acc, cur) => acc + cur + "<br>",
      ""
    );
    logMethod.apply(console, arguments);
  };
}

// START implementation
// ====================

async function startWebrtc() {
    // RTCPeerConnection setup.
    startWebrtcPc();

    // SDP Offer/Answer negotiation.
    startWebrtcSdp();

    // Media flow.
    await startWebrtcMedia();

    // Statistics.
    await startWebrtcStats();

    // Update UI.
    ui.start.disabled = true;
    ui.stop.disabled = false;
  }

  function startWebrtcPc() {
    const pcSend = new RTCPeerConnection();
    global.pcSend = pcSend;

    const pcRecv = new RTCPeerConnection();
    global.pcRecv = pcRecv;

    async function onIceCandidate(iceEvent, pc) {
      if (iceEvent.candidate) {
        // Send the candidate to the remote peer.
        try {
          await pc.addIceCandidate(iceEvent.candidate);
        } catch (error) {
          console.error("[onIceCandidate] Error:", error);
        }
      } else {
        console.log("[onIceCandidate] All ICE candidates have been sent");
      }
    }

    pcSend.addEventListener("icecandidate", (iceEvent) =>
      onIceCandidate(iceEvent, pcRecv)
    );
    pcRecv.addEventListener("icecandidate", (iceEvent) =>
      onIceCandidate(iceEvent, pcSend)
    );
  }

  function startWebrtcSdp() {
    const pcSend = global.pcSend;
    const pcRecv = global.pcRecv;

    pcSend.addEventListener("negotiationneeded", async () => {
      console.log("[on pcSend.negotiationneeded]");

      try {
        const sdpOffer = await pcSend.createOffer();
        await pcSend.setLocalDescription(sdpOffer);
        await pcRecv.setRemoteDescription(pcSend.localDescription);
        // console.log("[pcSend] SDP Offer:", pcSend.localDescription.sdp);

        const sdpAnswer = await pcRecv.createAnswer();
        await pcRecv.setLocalDescription(sdpAnswer);
        await pcSend.setRemoteDescription(pcRecv.localDescription);
        // console.log("[pcRecv] SDP Answer:", pcRecv.localDescription.sdp);
      } catch (err) {
        console.error("[on pcSend.negotiationneeded] Error:", err);
      }
    });

    pcRecv.addEventListener("iceconnectionstatechange", () => {
      console.log(
        "[on pcRecv.iceconnectionstatechange] pcRecv.iceConnectionState:",
        pcRecv.iceConnectionState
      );
    });
  }

  async function startWebrtcMedia() {
    const pcSend = global.pcSend;
    const pcRecv = global.pcRecv;

    pcRecv.addEventListener("track", (trackEvent) => {
      console.log(
        `[on pcRecv.track] kind: ${trackEvent.track.kind}, direction: ${trackEvent.transceiver.direction}`
      );

      // Show the stream and start playback.
      // NOTE: Playback doesn't start automatically because the <video> element
      // is not "autoplay", which is an attribute that we recommend avoiding.
      const remoteVideo = document.getElementById("uiRemoteVideo");
      remoteVideo.srcObject = trackEvent.streams[0];
      remoteVideo.play();
    });

    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
    } catch (err) {
      console.error("[startWebrtcMedia] Error:", err);
      return;
    }

    // Show the stream and start playback.
    // NOTE: Playback doesn't start automatically because the <video> element
    // is not "autoplay", which is an attribute that we recommend avoiding.
    const localVideo = document.getElementById("uiLocalVideo");
    localVideo.srcObject = localStream;
    localVideo.play();

    // Add the new tracks to the sender PeerConnection.
    for (const track of localStream.getTracks()) {
      // NOTE: addTrack() causes creation of a "sendrecv" RTCRtpTransceiver.
      //       https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/addTrack#New_senders
      // NOTE: addTrack() triggers event "negotiationneeded".
      const sender = pcSend.addTrack(track, localStream);

      // Log the new track and its corresponding transceiver's direction.
      const tc = pcSend.getTransceivers().find((tc) => tc.sender == sender);
      console.log(
        `[pcSend.addTrack] kind: ${track.kind}, direction: ${tc.direction}`
      );
    }
  }

  async function startWebrtcStats() {
    // Retrieve stats once per second; this is needed to calculate values such as
    // bitrates (bits per second) or interval losses (packets lost per second).
    const intervalID = setInterval(async () => {
      const pc = global.pcSend;

      // RTCStatsReport behaves like a Map. Each value is an RTCStats-derived
      // object, where "type" is one of the RTCStatsType enum.
      //
      // Doc:
      // - RTCStatsReport: https://w3c.github.io/webrtc-pc/#dom-rtcstatsreport
      // - RTCStats: https://w3c.github.io/webrtc-pc/#dom-rtcstats
      // - RTCStatsType: https://w3c.github.io/webrtc-stats/#dom-rtcstatstype
      const statsMap = await pc.getStats();

      // DEBUG - Print all contents of the RTCStatsReport.
      // statsMap.forEach((stats) => console.log(JSON.stringify(stats)));

      // printWebRtcStats(statsMap);

      // Print all stats that contain "frameWidth"
      statsMap.forEach((stats) => {
        if ("frameWidth" in stats) {
          console.log(
            `stats type: ${stats.type}, frameWidth: ${stats.frameWidth}`
          );
        }
      });
    }, 1000);
    global.statsInterval = intervalID;
  }

  function printWebRtcStats(statsMap) {
    // Filter and match stats, to find the wanted values
    // (report only from first video track that is found)

    // Note: in TypeScript, most of these would be using the '?' operator.

    const localOutVideoStats = Array.from(statsMap.values()).find(
      (stats) => stats.type === "outbound-rtp" && stats.kind === "video"
    );
    const remoteInVideoStats = statsMap.get(localOutVideoStats.remoteId);
    const codecStats = statsMap.get(localOutVideoStats.codecId);
    const transportStats = statsMap.get(localOutVideoStats.transportId);
    const candidatePairStats = statsMap.get(
      transportStats.selectedCandidatePairId
    );
    const localCandidateStats = statsMap.get(candidatePairStats.localCandidateId);
    const remoteCandidateStats = statsMap.get(
      candidatePairStats.remoteCandidateId
    );

    // Calculate per-second values.
    const bytesSentPerS =
      localOutVideoStats.bytesSent - global.printWebRtcStats.bytesSent;

    // Update values in memory, for the next iteration.
    global.printWebRtcStats.bytesSent = localOutVideoStats.bytesSent;

    // Prepare data and print all values.
    const bitrateSentKbps = (bytesSentPerS * 8) / 1000.0;
    const availableInBitrateKbps = candidatePairStats.availableIncomingBitrate
      ? candidatePairStats.availableIncomingBitrate / 1000.0
      : 0;
    const availableOutBitrateKbps = candidatePairStats.availableOutgoingBitrate
      ? candidatePairStats.availableOutgoingBitrate / 1000.0
      : 0;
    let data = {};
    data.localSsrc = localOutVideoStats.ssrc;
    data.remoteSsrc = remoteInVideoStats.ssrc;
    data.codec = codecStats.mimeType;
    data.localPort = localCandidateStats.port;
    data.remotePort = remoteCandidateStats.port;
    data.packetsSent = localOutVideoStats.packetsSent;
    data.retransmittedPacketsSent = localOutVideoStats.retransmittedPacketsSent;
    data.bytesSent = localOutVideoStats.bytesSent;
    data.nackCount = localOutVideoStats.nackCount;
    data.firCount = localOutVideoStats.firCount ? localOutVideoStats.firCount : 0;
    data.pliCount = localOutVideoStats.pliCount ? localOutVideoStats.pliCount : 0;
    data.sliCount = localOutVideoStats.sliCount ? localOutVideoStats.sliCount : 0;
    data.iceRoundTripTime = candidatePairStats.currentRoundTripTime;
    data.bitrateSentKbps = bitrateSentKbps;
    data.availableInBitrateKbps = availableInBitrateKbps;
    data.availableOutBitrateKbps = availableOutBitrateKbps;

    console.log("[printWebRtcStats] VIDEO STATS:", data);
  }

  // STOP implementation
  // ===================

  function stopWebrtc() {
    clearInterval(global.statsInterval);

    ui.localVideo.pause();
    ui.localVideo.srcObject = null;
    ui.remoteVideo.pause();
    ui.remoteVideo.srcObject = null;

    global.pcSend.close();
    global.pcSend = null;
    global.pcRecv.close();
    global.pcRecv = null;

    // Update UI.
    ui.start.disabled = false;
    ui.stop.disabled = true;

    console.log("[stopWebrtc] Stopped");
  }


ipcRenderer.on('screen-share-ready', (event, message) => {
    // User has chosen a screen to share. screenId is message parameter
    showSession();
    publisher = openvidu.initPublisher("publisher", {
        videoSource: "screen:" + message
    });
    joinSession();
});

function initPublisher() {

    openvidu = new OpenVidu();

    const shareScreen = document.getElementById("screen-sharing").checked;
    if (shareScreen) {
        openScreenShareModal();
    } else {
        publisher = openvidu.initPublisher("publisher");
        joinSession();
    }
}

function joinSession() {

    session = openvidu.initSession();
    session.on("streamCreated", function (event) {
        session.subscribe(event.stream, "subscriber");
    });

    mySessionId = document.getElementById("sessionId").value;

    getToken(mySessionId).then(token => {
        session.connect(token, {clientData: 'OpenVidu Electron'})
            .then(() => {
                showSession();
                session.publish(publisher);
            })
            .catch(error => {
                console.log("There was an error connecting to the session:", error.code, error.message);
            });
    });
}

function leaveSession() {
    session.disconnect();
    hideSession();
}

function showSession() {
    document.getElementById("session-header").innerText = mySessionId;
    document.getElementById("join").style.display = "none";
    document.getElementById("session").style.display = "block";
}

function hideSession() {
    document.getElementById("join").style.display = "block";
    document.getElementById("session").style.display = "none";
}

function openScreenShareModal() {
    let win = new BrowserWindow({
        parent: require('electron').remote.getCurrentWindow(),
        modal: true,
        minimizable: false,
        maximizable: false,
        webPreferences: {
            nodeIntegration: true
        },
        resizable: false
    })
    win.setMenu(null);
    // win.webContents.openDevTools();

    var theUrl = 'file://' + __dirname + '/modal.html'
    win.loadURL(theUrl);
}


/**
 * --------------------------
 * SERVER-SIDE RESPONSIBILITY
 * --------------------------
 * These methods retrieve the mandatory user token from OpenVidu Server.
 * This behavior MUST BE IN YOUR SERVER-SIDE IN PRODUCTION (by using
 * the API REST, openvidu-java-client or openvidu-node-client):
 *   1) Initialize a session in OpenVidu Server	(POST /api/sessions)
 *   2) Generate a token in OpenVidu Server		(POST /api/tokens)
 *   3) The token must be consumed in Session.connect() method
 */

var OPENVIDU_SERVER_URL = "https://localhost:4443";
var OPENVIDU_SERVER_SECRET = "MY_SECRET";

function getToken(mySessionId) {
    return createSession(mySessionId).then(sessionId => createToken(sessionId));
}

function createSession(sessionId) { // See https://docs.openvidu.io/en/stable/reference-docs/REST-API/#post-apisessions
    return new Promise((resolve, reject) => {
        axios.post(
                OPENVIDU_SERVER_URL + "/api/sessions",
                JSON.stringify({
                    customSessionId: sessionId
                }), {
                    headers: {
                        'Authorization': "Basic " + btoa("OPENVIDUAPP:" + OPENVIDU_SERVER_SECRET),
                        'Content-Type': 'application/json',
                    },
                    crossdomain: true
                }
            )
            .then(res => {
                if (res.status === 200) {
                    // SUCCESS response from openvidu-server. Resolve token
                    resolve(res.data.id);
                } else {
                    // ERROR response from openvidu-server. Resolve HTTP status
                    reject(new Error(res.status.toString()));
                }
            }).catch(error => {
                if (error.response.status === 409) {
                    resolve(sessionId);
                    return false;
                } else {
                    console.warn('No connection to OpenVidu Server. This may be a certificate error at ' + OPENVIDU_SERVER_URL);
                    return false;
                }
            });
        return false;
    });
}

function createToken(sessionId) { // See https://docs.openvidu.io/en/stable/reference-docs/REST-API/#post-apitokens
    return new Promise((resolve, reject) => {
        axios.post(
                OPENVIDU_SERVER_URL + "/api/tokens",
                JSON.stringify({
                    session: sessionId
                }), {
                    headers: {
                        'Authorization': "Basic " + btoa("OPENVIDUAPP:" + OPENVIDU_SERVER_SECRET),
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                }
            )
            .then(res => {
                if (res.status === 200) {
                    // SUCCESS response from openvidu-server. Resolve token
                    resolve(res.data.token);
                } else {
                    // ERROR response from openvidu-server. Resolve HTTP status
                    reject(new Error(res.status.toString()));
                }
            }).catch(error => {
                reject(error);
            });
        return false;
    });
}