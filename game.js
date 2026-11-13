/**
 * JELLY TAP v3 — 외곽까지 움직이는 출렁임 + 타격 효과음
 *
 * 원본 assets/character.png는 그대로 유지합니다.
 * assets/belly.png / hands.png 는 원본에서 분리한 투명 레이어입니다.
 * 배의 '픽셀'만이 아니라 배 레이어 전체의 알파 외곽선을 변형합니다.
 * 손은 언제나 정적인 최상단 레이어로 렌더링합니다.
 * WebGL2 우선 / Canvas2D 호환 모드.
 */
(() => {
  "use strict";

  const PADDED_W = 1753;
  const PADDED_H = 1026;
  const MAX_WAVES = 12;
  const DURATION = 3.5;

  const canvas = document.querySelector("#gameCanvas");
  const fallbackImage = document.querySelector("#fallbackImage");
  const counter = document.querySelector("#hitCount");
  const helper = document.querySelector("#sceneHelp");
  const errEl = document.querySelector("#errorMessage");
  const powerInput = document.querySelector("#power");
  const jellyInput = document.querySelector("#jelly");
  const powerLabel = document.querySelector("#powerLabel");
  const jellyLabel = document.querySelector("#jellyLabel");
  const volumeInput = document.querySelector("#volume");
  const volumeLabel = document.querySelector("#volumeLabel");
  const muteButton = document.querySelector("#muteButton");

  const assets = {
    belly: loadImage("./assets/belly.png"),
    hands: loadImage("./assets/hands.png"),
    base: loadImage("./assets/composite_padded.png")
  };

  let gl = null;
  let program = null;
  let uniforms = null;
  let renderer = "webgl";
  let cpu = null;
  let bellyHitMask = null;
  let ready = false;
  let animating = false;
  let lastCpuTime = 0;
  let power = Number(powerInput.value);
  let jelly = Number(jellyInput.value);
  let hitCount = 0;
  const waves = [];

  // v3 효과음. MP3 파일은 원본 그대로 포함하며, 배를 때린 경우에만 재생됩니다.
  // Web Audio API는 클릭별로 독립된 소스를 만들어 빠르게 연타해도 소리가 겹칩니다.
  // MP3가 아직 디코딩되지 않았거나 Web Audio를 쓸 수 없으면 HTMLAudio로 보완합니다.
  const SOUND_URL = "./assets/slap.mp3";
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  let soundVolume = Number(volumeInput.value) / 100;
  let soundMuted = false;
  let audioContext = null;
  let masterVolume = null;
  let hitAudioBuffer = null;
  const fallbackAudioPool = [];
  const MAX_FALLBACK_AUDIO = 12;

  function prepareHitAudio() {
    if (!AudioContextCtor) return;
    try {
      audioContext = new AudioContextCtor({ latencyHint: "interactive" });
      masterVolume = audioContext.createGain();
      masterVolume.gain.value = soundVolume;
      masterVolume.connect(audioContext.destination);
      // 디코딩은 미리 진행할 수 있고, 실제 소리 출력은 사용자의 클릭으로 활성화합니다.
      fetch(SOUND_URL).then(response => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.arrayBuffer();
      }).then(bytes => audioContext.decodeAudioData(bytes))
        .then(buffer => { hitAudioBuffer = buffer; })
        .catch(e => console.warn("Web Audio 효과음 로딩 실패. HTMLAudio로 재생합니다.", e));
    } catch (e) {
      console.warn("Web Audio 초기화 실패. HTMLAudio로 재생합니다.", e);
      audioContext = null;
      masterVolume = null;
    }
  }

  function syncSoundControls() {
    const audibleVolume = soundMuted ? 0 : soundVolume;
    volumeLabel.textContent = Math.round(soundVolume * 100) + "%";
    muteButton.textContent = soundMuted ? "🔇 음소거됨" : "🔊 소리 켜짐";
    muteButton.setAttribute("aria-pressed", String(soundMuted));
    if (audioContext && masterVolume) {
      masterVolume.gain.setTargetAtTime(audibleVolume, audioContext.currentTime, 0.008);
    }
    for (const audio of fallbackAudioPool) audio.volume = audibleVolume;
  }

  function playHtmlAudioFallback() {
    let audio = fallbackAudioPool.find(item => item.paused || item.ended);
    if (!audio) {
      if (fallbackAudioPool.length < MAX_FALLBACK_AUDIO) {
        audio = new Audio(SOUND_URL);
        audio.preload = "auto";
        fallbackAudioPool.push(audio);
      } else {
        // 너무 빠른 연타에는 가장 먼저 만들었던 채널을 재사용합니다.
        audio = fallbackAudioPool.shift();
        fallbackAudioPool.push(audio);
        audio.pause();
      }
    }
    audio.volume = soundVolume;
    try { audio.currentTime = 0; } catch (_) { /* 아직 메타데이터 로딩 전 */ }
    audio.play().catch(e => console.warn("효과음을 재생할 수 없습니다.", e));
  }

  function playHitSound() {
    // 효과음은 배를 유효하게 클릭했을 때만 재생됩니다.
    if (soundMuted || soundVolume <= 0) return;
    if (audioContext) {
      // 브라우저 자동 재생 제한: 실제 사용자 클릭/터치 이벤트에서만 호출됩니다.
      if (audioContext.state === "suspended") {
        audioContext.resume().catch(e => console.warn("오디오 활성화 실패", e));
      }
      if (hitAudioBuffer && audioContext.state !== "closed") {
        const source = audioContext.createBufferSource();
        source.buffer = hitAudioBuffer;
        source.connect(masterVolume);
        source.onended = () => source.disconnect();
        source.start(0);
        return;
      }
    }
    // 첫 클릭 직전까지 디코딩이 끝나지 않았을 때에도 소리가 나도록 합니다.
    playHtmlAudioFallback();
  }
  prepareHitAudio();
  syncSoundControls();


  function loadImage(url) {
    const image = new Image();
    image.src = url;
    return image;
  }

  function imageReady(image) {
    return new Promise((resolve, reject) => {
      if (image.complete) {
        if (image.naturalWidth) resolve(image);
        else reject(new Error(image.src + " 이미지를 읽지 못했습니다."));
        return;
      }
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(image.src + " 이미지를 읽지 못했습니다."));
    });
  }

  function error(message) {
    errEl.hidden = false;
    errEl.textContent = message;
    fallbackImage.style.display = "block";
    canvas.style.display = "none";
  }

  // Y가 아래로 커지는 이미지 좌표(px) 기준. 마스크는 움직이지 않는
  // 클릭 판정에만 쓰고, 렌더링의 배 경계는 실제 알파가 직접 결정합니다.
  function buildHitMask(image) {
    const c = document.createElement("canvas");
    c.width = PADDED_W;
    c.height = PADDED_H;
    const ctx = c.getContext("2d", {willReadFrequently: true});
    ctx.drawImage(image, 0, 0);
    bellyHitMask = ctx.getImageData(0, 0, PADDED_W, PADDED_H).data;
  }

  function isBelly(x, y) {
    if (!bellyHitMask) return false;
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= PADDED_W || py >= PADDED_H) return false;
    return bellyHitMask[(py * PADDED_W + px) * 4 + 3] >= 125;
  }

  // 배의 윤곽이 함께 이동하도록 모든 픽셀에서 displacement를 계산합니다.
  // 변형한 배 텍스처의 알파도 같이 이동하기 때문에 원래 경계에 묶이지 않습니다.
  const vertexSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = 0.5 * (a_position + vec2(1.0));
      gl_Position = vec4(a_position, 0.0, 1.0);
    }`;

  const fragmentSource = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 out_color;
    uniform sampler2D u_belly;
    uniform sampler2D u_hands;
    uniform vec2 u_sceneSize;
    uniform float u_time;
    uniform float u_power;
    uniform float u_jelly;
    uniform int u_waveCount;
    uniform vec4 u_waves[12];

    void main() {
      vec2 pos = vec2(v_uv.x, 1.0-v_uv.y) * u_sceneSize;
      vec2 displacement = vec2(0.0);
      float shine = 0.0;

      for (int i=0; i<12; ++i) {
        if (i >= u_waveCount) break;
        vec4 wave = u_waves[i];
        float age = u_time - wave.z;
        if (age < 0.0 || age > 3.5*u_jelly) continue;

        vec2 diff = pos-wave.xy;
        float dist = max(length(diff), 0.001);
        vec2 radial = diff/dist;
        float front = dist - 640.0/sqrt(u_jelly)*age;
        float width = 128.0 + 18.0*u_jelly;
        float shell = exp(-pow(front/width, 2.0));
        float decay = exp(-0.62*age/u_jelly);
        float ring = sin(front*0.031)*shell*decay;
        float wobble = sin(12.0*age-0.015*dist)
                     * exp(-dist/840.0)
                     * exp(-1.45*age/u_jelly);
        float dent = cos(age*17.0)*exp(-pow(dist/135.0, 2.0))
                   * exp(-2.5*age/u_jelly);
        float amp = (43.0*ring + 11.0*wobble + 9.0*dent)
                  * wave.w*u_power;
        displacement += radial*amp;
        shine += (0.35*cos(front*0.031)*shell*decay
               + 0.22*wobble)*wave.w*u_power;
      }

      // 출력 좌표의 역방향에서 원본을 샘플링함으로써
      // 배 표면, 배 외곽(alpha edge)이 같은 물리 파동에 함께 반응합니다.
      vec2 sourcePos = pos - displacement;
      vec2 sampleUv = vec2(
        sourcePos.x/u_sceneSize.x,
        1.0-sourcePos.y/u_sceneSize.y
      );
      vec4 movingBelly = texture(u_belly, sampleUv);
      // 손은 입력 uv를 그대로 읽으므로 절대로 변형되지 않습니다.
      vec4 stillHands = texture(u_hands, v_uv);

      // 배의 원래 광택을 유지하며 반사광만 약하게 보강.
      movingBelly.rgb = clamp(
        movingBelly.rgb + vec3(0.10, 0.079, 0.12)*shine, 0.0, 1.0
      );

      float a = stillHands.a + movingBelly.a*(1.0-stillHands.a);
      vec3 premul = stillHands.rgb*stillHands.a
                  + movingBelly.rgb*movingBelly.a*(1.0-stillHands.a);
      out_color = vec4(premul/max(a, 0.00001), a);
    }`;

  function compileShader(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const msg = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error("셰이더 컴파일 실패: " + msg);
    }
    return shader;
  }

  function createProgram() {
    const p = gl.createProgram();
    const vs = compileShader(gl.VERTEX_SHADER, vertexSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("셰이더 링크 실패: " + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function makeTexture(image, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  function initWebGL() {
    gl = canvas.getContext("webgl2",
      {alpha: true, antialias: true, premultipliedAlpha: false});
    if (!gl) return false;

    program = createProgram();
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

    makeTexture(assets.belly, 0);
    makeTexture(assets.hands, 1);
    gl.uniform1i(gl.getUniformLocation(program, "u_belly"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "u_hands"), 1);
    uniforms = {
      size: gl.getUniformLocation(program, "u_sceneSize"),
      time: gl.getUniformLocation(program, "u_time"),
      power: gl.getUniformLocation(program, "u_power"),
      jelly: gl.getUniformLocation(program, "u_jelly"),
      count: gl.getUniformLocation(program, "u_waveCount"),
      waves: gl.getUniformLocation(program, "u_waves[0]")
    };

    ready = true;
    fallbackImage.style.display = "none";
    resize();
    if ("ResizeObserver" in window) {
      new ResizeObserver(resize).observe(canvas);
    } else window.addEventListener("resize", resize);
    return true;
  }

  function getScaledPixels(image, w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", {willReadFrequently: true});
    ctx.drawImage(image, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }

  function initCpuFallback() {
    renderer = "cpu";
    const w = 585;
    const h = Math.round(PADDED_H*w/PADDED_W);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", {alpha: true});
    if (!ctx) throw new Error("Canvas 2D 초기화 실패");
    cpu = {
      ctx, w, h, scale: w/PADDED_W,
      base: getScaledPixels(assets.base,w,h),
      belly: getScaledPixels(assets.belly,w,h),
      hands: getScaledPixels(assets.hands,w,h),
      buffer: ctx.createImageData(w,h)
    };
    ready = true;
    fallbackImage.style.display = "none";
    document.querySelector(".site-footer").textContent =
      "Canvas 2D 호환 모드 · 배 외곽선도 함께 움직입니다";
    drawFrame(performance.now()/1000);
  }

  // Canvas 2D 호환 모드에서도 정적인 경계를 섞지 않습니다.
  // 이동한 배 레이어의 알파를 손 레이어 위가 아닌 아래에 합성합니다.
  function drawCpu(now) {
    const {ctx,w,h,scale,base,belly,hands,buffer} = cpu;
    const out = buffer.data;
    out.set(base);
    if (!waves.length) {
      ctx.putImageData(buffer,0,0);
      return;
    }
    const active = waves.slice(-5);
    const pw = w-1, ph=h-1;
    const invScale = 1/scale;

    for (let y=0;y<h;y++) {
      const py=y*invScale;
      for (let x=0;x<w;x++) {
        const i=(y*w+x)*4;
        const handAlpha=hands[i+3]/255;
        // 완전히 불투명한 손의 픽셀은 변형 계산 생략.
        if (handAlpha>0.999) continue;

        const px=x*invScale;
        let dxTotal=0, dyTotal=0, shine=0;
        for (const wave of active) {
          const age=now-wave.startedAt;
          if (age<0 || age>DURATION*jelly) continue;
          const dx=px-wave.x, dy=py-wave.y;
          const dist=Math.hypot(dx,dy);
          const front=dist-(640/Math.sqrt(jelly))*age;
          const width=128+18*jelly;
          const shell=Math.exp(-((front/width)**2));
          const decay=Math.exp(-0.62*age/jelly);
          const ring=Math.sin(front*0.031)*shell*decay;
          const wobble=Math.sin(12*age-0.015*dist)
                      * Math.exp(-dist/840)*Math.exp(-1.45*age/jelly);
          const dent=Math.cos(age*17)*Math.exp(-((dist/135)**2))
                     * Math.exp(-2.5*age/jelly);
          const amp=(43*ring+11*wobble+9*dent)*wave.strength*power;
          dxTotal+=(dx/Math.max(0.001,dist))*amp;
          dyTotal+=(dy/Math.max(0.001,dist))*amp;
          shine+=(0.35*Math.cos(front*0.031)*shell*decay+0.22*wobble)
                * wave.strength*power;
        }
        const fx=x-dxTotal*scale;
        const fy=y-dyTotal*scale;
        if (fx<0 || fy<0 || fx>=pw || fy>=ph) {
          if (handAlpha===0) {
            out[i]=0;out[i+1]=0;out[i+2]=0;out[i+3]=0;
          } else {
            for (let k=0;k<4;k++) out[i+k]=hands[i+k];
          }
          continue;
        }
        const x0=fx|0,y0=fy|0;
        const tx=fx-x0, ty=fy-y0;
        const off=(y0*w+x0)*4, row=w*4;
        const i00=off,i10=off+4,i01=off+row,i11=off+row+4;
        // RGB는 투명 영역에 동일 색을 연장해서 알파 경계의 검은 테두리를 방지.
        const bAlpha=(belly[i00+3]*(1-tx)*(1-ty)
                     +belly[i10+3]*tx*(1-ty)
                     +belly[i01+3]*(1-tx)*ty
                     +belly[i11+3]*tx*ty)/255;
        const alpha=handAlpha+bAlpha*(1-handAlpha);
        if (alpha<0.0001) {
          out[i]=0;out[i+1]=0;out[i+2]=0;out[i+3]=0;
          continue;
        }
        for (let ch=0;ch<3;ch++) {
          const b=(belly[i00+ch]*(1-tx)*(1-ty)
                  +belly[i10+ch]*tx*(1-ty)
                  +belly[i01+ch]*(1-tx)*ty
                  +belly[i11+ch]*tx*ty);
          const glow=[25.5,20,30.5][ch]*shine;
          const moved=Math.max(0,Math.min(255,b+glow));
          out[i+ch]=(hands[i+ch]*handAlpha+
            moved*bAlpha*(1-handAlpha))/alpha;
        }
        out[i+3]=alpha*255;
      }
    }
    ctx.putImageData(buffer,0,0);
  }

  function resize() {
    if (!ready || renderer==="cpu") return;
    const bounds=canvas.getBoundingClientRect();
    const dpr=Math.min(window.devicePixelRatio || 1,1.6);
    const w=Math.max(1,Math.round(bounds.width*dpr));
    const h=Math.max(1,Math.round(bounds.height*dpr));
    if (canvas.width!==w || canvas.height!==h) {
      canvas.width=w;
      canvas.height=h;
    }
    gl.viewport(0,0,w,h);
    drawFrame(performance.now()/1000);
  }

  function drawFrame(now) {
    if (!ready) return;
    for (let i=waves.length-1;i>=0;i--) {
      if (now-waves[i].startedAt>DURATION*jelly) waves.splice(i,1);
    }
    if (renderer==="cpu") {
      drawCpu(now);
      return;
    }
    gl.useProgram(program);
    gl.uniform2f(uniforms.size,PADDED_W,PADDED_H);
    gl.uniform1f(uniforms.time,now);
    gl.uniform1f(uniforms.power,power);
    gl.uniform1f(uniforms.jelly,jelly);
    gl.uniform1i(uniforms.count,waves.length);
    const waveArr=new Float32Array(MAX_WAVES*4);
    for (let i=0;i<waves.length;i++) {
      waveArr[i*4]=waves[i].x;
      waveArr[i*4+1]=waves[i].y;
      waveArr[i*4+2]=waves[i].startedAt;
      waveArr[i*4+3]=waves[i].strength;
    }
    gl.uniform4fv(uniforms.waves,waveArr);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  }

  function loop() {
    const ms=performance.now();
    if (renderer!=="cpu" || ms-lastCpuTime>=33) {
      drawFrame(ms/1000);
      lastCpuTime=ms;
    }
    if (waves.length) requestAnimationFrame(loop);
    else animating=false;
  }

  function startAnimation() {
    if (animating) return;
    animating=true;
    requestAnimationFrame(loop);
  }

  function tap(x,y) {
    if (!ready || !isBelly(x,y)) return false;
    waves.push({x,y,startedAt:performance.now()/1000,strength:1});
    if (waves.length>MAX_WAVES) waves.shift();
    counter.textContent=String(++hitCount);
    playHitSound();
    helper.classList.add("hidden");
    startAnimation();
    return true;
  }

  function pointerPosition(event) {
    const r=canvas.getBoundingClientRect();
    return {
      x:(event.clientX-r.left)/r.width*PADDED_W,
      y:(event.clientY-r.top)/r.height*PADDED_H
    };
  }

  canvas.addEventListener("pointerdown",event=>{
    event.preventDefault();
    const {x,y}=pointerPosition(event);
    tap(x,y);
  });
  canvas.addEventListener("pointermove",event=>{
    if (!ready) return;
    const {x,y}=pointerPosition(event);
    canvas.style.cursor=isBelly(x,y)?"pointer":"default";
  });
  canvas.addEventListener("pointerleave",()=>{
    canvas.style.cursor="default";
  });
  canvas.addEventListener("keydown",event=>{
    if (event.key==="Enter" || event.key===" ") {
      event.preventDefault();
      tap(PADDED_W/2,PADDED_H/2);
    }
  });

  document.querySelector("#resetButton").addEventListener("click",()=>{
    hitCount=0;
    counter.textContent="0";
    waves.length=0;
    helper.classList.remove("hidden");
    drawFrame(performance.now()/1000);
  });
  powerInput.addEventListener("input",()=>{
    power=Number(powerInput.value);
    powerLabel.textContent=power.toFixed(1)+"×";
    if (waves.length) startAnimation();
  });
  jellyInput.addEventListener("input",()=>{
    jelly=Number(jellyInput.value);
    jellyLabel.textContent=jelly.toFixed(1)+"×";
    if (waves.length) startAnimation();
  });

  volumeInput.addEventListener("input", () => {
    soundVolume = Number(volumeInput.value) / 100;
    syncSoundControls();
  });
  muteButton.addEventListener("click", () => {
    soundMuted = !soundMuted;
    syncSoundControls();
  });

  Promise.all(Object.values(assets).map(imageReady)).then(()=>{
    buildHitMask(assets.belly);
    try {
      if (!initWebGL()) initCpuFallback();
    } catch (e) {
      console.error(e);
      error("렌더링 초기화 오류: "+e.message);
    }
  }).catch(e=>{
    console.error(e);
    error("게임 이미지 파일을 불러오지 못했습니다. 로컬 웹 서버로 실행해 주세요.");
  });
})();
