import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Component, HostListener, OnDestroy } from '@angular/core';
import { AndroidPermissions } from '@ionic-native/android-permissions/ngx';
import { SplashScreen } from '@ionic-native/splash-screen/ngx';
import { StatusBar } from '@ionic-native/status-bar/ngx';
import { Platform, AlertController } from '@ionic/angular';
import { OpenVidu, Publisher, Session, StreamEvent, StreamManager, Subscriber } from 'openvidu-browser';
import { throwError as observableThrowError } from 'rxjs';
import { catchError } from 'rxjs/operators';
declare var cordova;

@Component({
    selector: 'app-root',
    templateUrl: 'app.component.html',
    styleUrls: ['app.component.css'],
})
export class AppComponent implements OnDestroy {

    OPENVIDU_SERVER_URL = 'https://' + location.hostname + ':4443';
    OPENVIDU_SERVER_SECRET = 'MY_SECRET';

    ANDROID_PERMISSIONS = [
        this.androidPermissions.PERMISSION.CAMERA,
        this.androidPermissions.PERMISSION.RECORD_AUDIO,
        this.androidPermissions.PERMISSION.MODIFY_AUDIO_SETTINGS
    ];

    // OpenVidu objects
    OV: OpenVidu;
    session: Session;
    publisher: StreamManager; // Local
    subscribers: StreamManager[] = []; // Remotes

    // Join form
    mySessionId: string;
    myUserName: string;

    global = {
        pcSend: null,
        pcRecv: null,
        statsInterval: null,

        // Memory used to calculate averages and rates.
        printWebRtcStats: { bytesSent: 0 },
    };

    ui: any = {};



    constructor(
        private platform: Platform,
        private splashScreen: SplashScreen,
        private statusBar: StatusBar,
        private httpClient: HttpClient,
        private androidPermissions: AndroidPermissions,
        public alertController: AlertController
    ) {
        this.initializeApp();
        this.generateParticipantInfo();
    }

    initializeApp() {
        this.platform.ready().then(() => {
            this.statusBar.styleDefault();
            this.splashScreen.hide();
            if (this.platform.is('ios') && this.platform.is('cordova')) {
                cordova.plugins.iosrtc.registerGlobals();
            }


            this.ui = {
                // Inputs
                start: false,
                stop: false,

              };


            this.ui.stop = true;

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



        });
    }

    async startWebrtc() {

        await this.checkAndroidPermissions();
        // RTCPeerConnection setup.
        this.startWebrtcPc();

        // SDP Offer/Answer negotiation.
        this.startWebrtcSdp();

        // Media flow.
        await this.startWebrtcMedia();

        // Statistics.
        await this.startWebrtcStats();

        // Update UI.
        this.ui.start = true;
        this.ui.stop = false;
      }

      startWebrtcPc() {
        const pcSend = new RTCPeerConnection();
        this.global.pcSend = pcSend;

        const pcRecv = new RTCPeerConnection();
        this.global.pcRecv = pcRecv;

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

      startWebrtcSdp() {
        const pcSend = this.global.pcSend;
        const pcRecv = this.global.pcRecv;

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

      async startWebrtcMedia() {
        const pcSend = this.global.pcSend;
        const pcRecv = this.global.pcRecv;

        pcRecv.addEventListener("track", (trackEvent) => {
          console.log(
            `[on pcRecv.track] kind: ${trackEvent.track.kind}, direction: ${trackEvent.transceiver.direction}`
          );

          // Show the stream and start playback.
          // NOTE: Playback doesn't start automatically because the <video> element
          // is not "autoplay", which is an attribute that we recommend avoiding.
          this.ui.remoteVideo.srcObject = trackEvent.streams[0];
          this.ui.remoteVideo.play();
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
        this.ui.localVideo.srcObject = localStream;
        this.ui.localVideo.play();

        // Add the new tracks to the sender PeerConnection.
        for (const track of localStream.getTracks()) {
          // NOTE: addTrack() causes creation of a "sendrecv" RTCRtpTransceiver.
          //       https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/addTrack#New_senders
          // NOTE: addTrack() triggers event "negotiationneeded".
          const sender = pcSend.addTrack(track, localStream);

          // Log the new track and its corresponding transceiver's direction.
          const tc = pcSend.getTransceivers().find((tc) => tc.sender === sender);
          console.log(
            `[pcSend.addTrack] kind: ${track.kind}, direction: ${tc.direction}`
          );
        }
      }

      async startWebrtcStats() {
        // Retrieve stats once per second; this is needed to calculate values such as
        // bitrates (bits per second) or interval losses (packets lost per second).
        const intervalID = setInterval(async () => {
          const pc = this.global.pcSend;

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
        this.global.statsInterval = intervalID;
      }


      printWebRtcStats(statsMap) {
        // Filter and match stats, to find the wanted values
        // (report only from first video track that is found)

        // Note: in TypeScript, most of these would be using the '?' operator.

        const localOutVideoStats:any = Array.from(statsMap.values()).find(
          (stats: any) => stats.type === "outbound-rtp" && stats.kind === "video"
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
          localOutVideoStats.bytesSent - this.global.printWebRtcStats.bytesSent;

        // Update values in memory, for the next iteration.
        this.global.printWebRtcStats.bytesSent = localOutVideoStats.bytesSent;

        // Prepare data and print all values.
        const bitrateSentKbps = (bytesSentPerS * 8) / 1000.0;
        const availableInBitrateKbps = candidatePairStats.availableIncomingBitrate
          ? candidatePairStats.availableIncomingBitrate / 1000.0
          : 0;
        const availableOutBitrateKbps = candidatePairStats.availableOutgoingBitrate
          ? candidatePairStats.availableOutgoingBitrate / 1000.0
          : 0;
        let data: any = {};
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

      stopWebrtc() {
        clearInterval(this.global.statsInterval);

        const localVideo: any = document.getElementById("uiLocalVideo");
        const remoteVideo: any = document.getElementById("uiRemoteVideo");

        localVideo.pause();
        localVideo.srcObject = null;
        remoteVideo.pause();
        remoteVideo.srcObject = null;

        this.global.pcSend.close();
        this.global.pcSend = null;
        this.global.pcRecv.close();
        this.global.pcRecv = null;

        // Update UI.
        this.ui.start = false;
        this.ui.stop = true;

        console.log("[stopWebrtc] Stopped");
      }




    @HostListener('window:beforeunload')
    beforeunloadHandler() {
        // On window closed leave session
        this.leaveSession();
    }

    ngOnDestroy() {
        // On component destroyed leave session
        this.leaveSession();
    }



    joinSession() {
        // --- 1) Get an OpenVidu object ---

        this.OV = new OpenVidu();

        // --- 2) Init a session ---

        this.session = this.OV.initSession();

        // --- 3) Specify the actions when events take place in the session ---

        // On every new Stream received...
        this.session.on('streamCreated', (event: StreamEvent) => {
            // Subscribe to the Stream to receive it. Second parameter is undefined
            // so OpenVidu doesn't create an HTML video on its own
            const subscriber: Subscriber = this.session.subscribe(event.stream, undefined);
            this.subscribers.push(subscriber);
        });

        // On every Stream destroyed...
        this.session.on('streamDestroyed', (event: StreamEvent) => {
            // Remove the stream from 'subscribers' array
            this.deleteSubscriber(event.stream.streamManager);
        });

        // --- 4) Connect to the session with a valid user token ---

        // 'getToken' method is simulating what your server-side should do.
        // 'token' parameter should be retrieved and returned by your own backend
        this.getToken().then((token) => {
            // First param is the token got from OpenVidu Server. Second param will be used by every user on event
            // 'streamCreated' (property Stream.connection.data), and will be appended to DOM as the user's nickname
            this.session
                .connect(token, { clientData: this.myUserName })
                .then(() => {
                    // --- 5) Requesting and Checking Android Permissions
                    if (this.platform.is('cordova')) {
                        // Ionic platform
                        if (this.platform.is('android')) {
                            console.log('Android platform');
                            this.checkAndroidPermissions()
                                .then(() => this.initPublisher())
                                .catch(err => console.error(err));
                        } else if (this.platform.is('ios')) {
                            console.log('iOS platform');
                            this.initPublisher();
                        }
                    } else {
                        this.initPublisher();
                    }
                })
                .catch(error => {
                    console.log('There was an error connecting to the session:', error.code, error.message);
                });
        });
    }

    initPublisher() {
        // Init a publisher passing undefined as targetElement (we don't want OpenVidu to insert a video
        // element: we will manage it on our own) and with the desired properties
        const publisher: Publisher = this.OV.initPublisher(undefined, {
            audioSource: undefined, // The source of audio. If undefined default microphone
            videoSource: undefined, // The source of video. If undefined default webcam
            publishAudio: true, // Whether you want to start publishing with your audio unmuted or not
            publishVideo: true, // Whether you want to start publishing with your video enabled or not
            resolution: '640x480', // The resolution of your video
            frameRate: 30, // The frame rate of your video
            insertMode: 'APPEND', // How the video is inserted in the target element 'video-container'
            mirror: true // Whether to mirror your local video or not
        });

        // --- 6) Publish your stream ---

        this.session.publish(publisher).then(() => {
            // Store our Publisher
            this.publisher = publisher;
        });
    }

    leaveSession() {
        // --- 7) Leave the session by calling 'disconnect' method over the Session object ---

        if (this.session) {
            this.session.disconnect();
        }

        // Empty all properties...
        this.subscribers = [];
        delete this.publisher;
        delete this.session;
        delete this.OV;
        this.generateParticipantInfo();
    }

    refreshVideos() {
        if (this.platform.is('ios') && this.platform.is('cordova')) {
            cordova.plugins.iosrtc.refreshVideos();
        }
    }

    private checkAndroidPermissions(): Promise<any> {
        return new Promise((resolve, reject) => {
            this.platform.ready().then(() => {
                this.androidPermissions
                    .requestPermissions(this.ANDROID_PERMISSIONS)
                    .then(() => {
                        this.androidPermissions
                            .checkPermission(this.androidPermissions.PERMISSION.CAMERA)
                            .then(camera => {
                                this.androidPermissions
                                    .checkPermission(this.androidPermissions.PERMISSION.RECORD_AUDIO)
                                    .then(audio => {
                                        this.androidPermissions
                                            .checkPermission(this.androidPermissions.PERMISSION.MODIFY_AUDIO_SETTINGS)
                                            .then(modifyAudio => {
                                                if (camera.hasPermission && audio.hasPermission && modifyAudio.hasPermission) {
                                                    resolve();
                                                } else {
                                                    reject(
                                                        new Error(
                                                            'Permissions denied: ' +
                                                            '\n' +
                                                            ' CAMERA = ' +
                                                            camera.hasPermission +
                                                            '\n' +
                                                            ' AUDIO = ' +
                                                            audio.hasPermission +
                                                            '\n' +
                                                            ' AUDIO_SETTINGS = ' +
                                                            modifyAudio.hasPermission,
                                                        ),
                                                    );
                                                }
                                            })
                                            .catch(err => {
                                                console.error(
                                                    'Checking permission ' +
                                                    this.androidPermissions.PERMISSION.MODIFY_AUDIO_SETTINGS +
                                                    ' failed',
                                                );
                                                reject(err);
                                            });
                                    })
                                    .catch(err => {
                                        console.error(
                                            'Checking permission ' + this.androidPermissions.PERMISSION.RECORD_AUDIO + ' failed',
                                        );
                                        reject(err);
                                    });
                            })
                            .catch(err => {
                                console.error('Checking permission ' + this.androidPermissions.PERMISSION.CAMERA + ' failed');
                                reject(err);
                            });
                    })
                    .catch(err => console.error('Error requesting permissions: ', err));
            });
        });
    }

    private generateParticipantInfo() {
        // Random user nickname and sessionId
        this.mySessionId = 'SessionA';
        this.myUserName = 'Participant' + Math.floor(Math.random() * 100);
    }

    private deleteSubscriber(streamManager: StreamManager): void {
        const index = this.subscribers.indexOf(streamManager, 0);
        if (index > -1) {
            this.subscribers.splice(index, 1);
        }
    }

    async presentSettingsAlert() {
        const alert = await this.alertController.create({
            header: 'OpenVidu Server config',
            inputs: [
                {
                    name: 'url',
                    type: 'text',
                    value: 'https://demos.openvidu.io',
                    placeholder: 'URL'
                },
                {
                    name: 'secret',
                    type: 'text',
                    value: 'MY_SECRET',
                    placeholder: 'Secret'
                }
            ],
            buttons: [
                {
                    text: 'Cancel',
                    role: 'cancel',
                    cssClass: 'secondary'
                }, {
                    text: 'Ok',
                    handler: data => {
                        this.OPENVIDU_SERVER_URL = data.url;
                        this.OPENVIDU_SERVER_SECRET = data.secret;
                    }
                }
            ]
        });

        await alert.present();
    }

    /*
     * --------------------------
     * SERVER-SIDE RESPONSIBILITY
     * --------------------------
     * This method retrieve the mandatory user token from OpenVidu Server,
     * in this case making use Angular http API.
     * This behaviour MUST BE IN YOUR SERVER-SIDE IN PRODUCTION. In this case:
     *   1) Initialize a session in OpenVidu Server	 (POST /api/sessions)
     *   2) Generate a token in OpenVidu Server		   (POST /api/tokens)
     *   3) The token must be consumed in Session.connect() method of OpenVidu Browser
     */

    getToken(): Promise<string> {
        if (this.platform.is('ios') && this.platform.is('cordova') && this.OPENVIDU_SERVER_URL === 'https://localhost:4443') {
            // To make easier first steps with iOS apps, use demos OpenVidu Sever if no custom valid server is configured
            this.OPENVIDU_SERVER_URL = 'https://demos.openvidu.io';
        }
        return this.createSession(this.mySessionId).then((sessionId) => {
            return this.createToken(sessionId);
        });
    }

    createSession(sessionId) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ customSessionId: sessionId });
            const options = {
                headers: new HttpHeaders({
                    Authorization: 'Basic ' + btoa('OPENVIDUAPP:' + this.OPENVIDU_SERVER_SECRET),
                    'Content-Type': 'application/json',
                }),
            };
            return this.httpClient
                .post(this.OPENVIDU_SERVER_URL + '/api/sessions', body, options)
                .pipe(
                    catchError((error) => {
                        if (error.status === 409) {
                            resolve(sessionId);
                        } else {
                            console.warn(
                                'No connection to OpenVidu Server. This may be a certificate error at ' +
                                this.OPENVIDU_SERVER_URL,
                            );
                            if (
                                window.confirm(
                                    'No connection to OpenVidu Server. This may be a certificate error at "' +
                                    this.OPENVIDU_SERVER_URL +
                                    // tslint:disable-next-line:max-line-length
                                    '"\n\nClick OK to navigate and accept it. If no certificate warning is shown, then check that your OpenVidu Server' +
                                    'is up and running at "' +
                                    this.OPENVIDU_SERVER_URL +
                                    '"',
                                )
                            ) {
                                location.assign(this.OPENVIDU_SERVER_URL + '/accept-certificate');
                            }
                        }
                        return observableThrowError(error);
                    }),
                )
                .subscribe((response) => {
                    console.log(response);
                    resolve(response['id']);
                });
        });
    }

    createToken(sessionId): Promise<string> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ session: sessionId });
            const options = {
                headers: new HttpHeaders({
                    Authorization: 'Basic ' + btoa('OPENVIDUAPP:' + this.OPENVIDU_SERVER_SECRET),
                    'Content-Type': 'application/json',
                }),
            };
            return this.httpClient
                .post(this.OPENVIDU_SERVER_URL + '/api/tokens', body, options)
                .pipe(
                    catchError((error) => {
                        reject(error);
                        return observableThrowError(error);
                    }),
                )
                .subscribe((response) => {
                    console.log(response);
                    resolve(response['token']);
                });
        });
    }
}
