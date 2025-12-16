import * as THREE from 'three';

// Simplex Noise for wind and variation
function noise(x, z) {
  return Math.sin(x * 0.1) * Math.sin(z * 0.1) + 
         Math.sin(x * 0.3 + 1.2) * Math.cos(z * 0.3 + 2.0) * 0.5;
}

const GRASS_VERTEX_LOGIC = `
  vec3 transformed = vec3( position );
  vHeight = uv.y;
  
  vec4 instancePosition = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 worldPos = (modelMatrix * instancePosition).xyz;
  vWorldPosition = worldPos;

  // --- WIND SYSTEM (Multi-Layered AAA Approach) ---
  // Use accumulated wind time for variable speed phases
  float time = uWindTime * 0.5;
  
  // Layer 1: Macro Wind (Broad sweeping waves) - Red Channel
  // Low frequency, high amplitude. Simulates large air masses moving.
  vec2 windUV = worldPos.xz * 0.003 + vec2(time * 0.05, time * 0.02);
  float macroWind = texture2D(uWindNoise, windUV).r;
  
  // Layer 2: Turbulence (Gusts) - Green Channel
  // Medium frequency. Simulates chaotic turbulence within the macro flow.
  vec2 gustUV = worldPos.xz * 0.02 + vec2(time * 0.2, time * 0.1);
  float gustWind = texture2D(uWindNoise, gustUV).g;
  
  // Layer 3: Micro Flutter (Procedural Detail)
  // High frequency, low amplitude. Simulates blade vibration.
  // Scale frequency by strength so it vibrates faster when windy
  float flutterFreq = 12.0 + (uWindStrength * 5.0);
  float flutter = sin(time * flutterFreq + worldPos.x * 2.0 + worldPos.z) * 
                  cos(time * (flutterFreq * 1.5) + worldPos.z * 1.5);
                  
  // Composite Wind Strength (Normalized 0.0 to 1.0)
  float windStrength = macroWind * 0.6 + gustWind * 0.4;
  
  // Apply Global Intensity (Gusts vs Lulls)
  windStrength *= uWindStrength;
  
  // Attenuate flutter when calm
  float flutterAmp = 0.05 * clamp(uWindStrength, 0.2, 1.0);
  windStrength += flutter * flutterAmp;

  // --- INTERACTION SYSTEM (State-based + Restoration) ---
  
  // 1. Trail History (Persistent deformation from FBO)
  vec2 mapUV = (worldPos.xz + (uTerrainSize * 0.5)) / uTerrainSize;
  mapUV = clamp(mapUV, 0.0, 1.0);
  mapUV.y = 1.0 - mapUV.y; 
  float trailData = texture2D(uTrailMap, mapUV).r;
  
  // 2. Player Immediate Presence (Proximity mask)
  float dist = distance(worldPos.xz, uPlayerPos.xz);
  float playerRadius = 0.7;
  float playerPress = 1.0 - smoothstep(playerRadius * 0.5, playerRadius, dist);
  playerPress = pow(playerPress, 2.0); // Sharper inner circle
  
  // 3. Dynamic Wind Restoration
  // "Wind system continuously applies a restoration force... masked to zero where player is standing."
  // We use the wind strength to temporarily lift the trail effect, creating a "struggle" visual.
  
  // Mask: 0.0 if under player (cannot recover), 1.0 if free (can recover)
  float recoveryMask = 1.0 - playerPress;
  
  // Restoration force: Stronger wind lifts grass more.
  float restorationForce = windStrength * 0.7 * recoveryMask;
  
  // Apply restoration to trail:
  // If wind is strong, effective trail reduces (grass bounces up).
  // If wind is calm, trail remains flat.
  float effectiveTrail = trailData * (1.0 - restorationForce);
  
  // Final Crush State: Player weight overrides all recovery
  float totalCrush = max(playerPress, effectiveTrail);
  totalCrush = clamp(totalCrush, 0.0, 1.0);

  // --- DISPLACEMENT ---
  
  // Stiffness: Crushed grass is stiff (0.0), upright is flexible (1.0)
  float stiffness = 1.0 - totalCrush;
  
  // Directional Wind Bend
  vec3 windDir = normalize(vec3(1.0, 0.0, 0.5));
  float bendAmount = windStrength * 1.5 * stiffness * pow(vHeight, 2.0);
  
  transformed.x += windDir.x * bendAmount;
  transformed.z += windDir.z * bendAmount;
  
  // Add flutter to tips
  transformed.y += flutter * flutterAmp * stiffness * vHeight;
  
  // --- REALISTIC CRUSH ROTATION ---
  
  // Determine rotation axis. 
  // If player is close, use push direction.
  // For old trails, use a stable random direction to prevent jittering artifacts.
  
  vec2 playerPushDir = normalize(worldPos.xz - uPlayerPos.xz);
  if (length(worldPos.xz - uPlayerPos.xz) < 0.01) playerPushDir = vec2(1.0, 0.0);
  
  // Procedural stable direction
  float noiseAngle = dot(worldPos.xz, vec2(12.9898, 78.233));
  vec2 randomDir = normalize(vec2(sin(noiseAngle), cos(noiseAngle)));
  
  // Blend direction based on freshness of interaction
  vec2 finalDir = mix(randomDir, playerPushDir, playerPress);
  vec3 crushAxis = normalize(cross(vec3(0, 1, 0), vec3(finalDir.x, 0, finalDir.y)));
  
  // Rotation Angle
  float angle = totalCrush * 1.5; // Up to ~85 degrees
  float c = cos(angle);
  float s = sin(angle);
  vec3 v = transformed;
  
  // Rodrigues rotation
  vec3 rotated = v * c + cross(crushAxis, v) * s + crushAxis * dot(crushAxis, v) * (1.0 - c);
  transformed = rotated;
  
  // Grounding: Sink slightly when crushed to prevent floating roots
  transformed.y -= totalCrush * 0.15 * vHeight;
  
  // --- NORMALS ---
  #ifndef USE_SHADOWMAP
    vec3 n = objectNormal;
    // Rotate normal to match geometry
    n = n * c + cross(crushAxis, n) * s + crushAxis * dot(crushAxis, n) * (1.0 - c);
    // Mix with World Up for softer, translucent lighting look
    objectNormal = normalize(mix(n, vec3(0,1,0), 0.4));
  #endif
`;

export class GrassSystem {
  constructor(scene, getTerrainHeight, renderer) {
    // Generate Wind Noise Texture
    const windTex = this.generateWindNoiseTexture();

    this.uniforms = { 
      uTime: { value: 0 }, 
      uPlayerPos: { value: new THREE.Vector3(0, -100, 0) },
      uPlayerVel: { value: new THREE.Vector3(0, 0, 0) },
      uTrailMap: { value: null }, 
      uTerrainSize: { value: 200.0 },
      uWindNoise: { value: windTex },
      uWindTime: { value: 0 },      // Accumulated time based on wind speed
      uWindStrength: { value: 1.0 } // Current global wind multiplier
    };
    
    this.windTime = 0;
    this.currentWindStrength = 1.0;

    this.renderer = renderer;
    this.scene = scene;
    this.getTerrainHeight = getTerrainHeight;
    this.lastPlayerPos = new THREE.Vector3(0, -100, 0);
    
    this.group = new THREE.Group();
    scene.add(this.group);

    // Initialize the trail persistence system (FBO)
    this.initTrailSystem();
    
    // Initialize Geometry and Material reused by all chunks
    this.baseGeometry = this.createGeometry();
    this.initMaterials();

    // Create Grass Chunks
    this.chunks = [];
    this.initChunks();
  }

  generateWindNoiseTexture() {
    // Multi-layered Noise Texture Generation
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    // Fill background with base wind level
    ctx.fillStyle = '#202020'; 
    ctx.fillRect(0, 0, size, size);
    
    // Helper: Draw additive noise blobs
    const drawNoiseLayer = (colorStr, count, minR, maxR) => {
        ctx.globalCompositeOperation = 'screen'; // additive blend
        for (let i = 0; i < count; i++) {
            const x = Math.random() * size;
            const y = Math.random() * size;
            const r = Math.random() * (maxR - minR) + minR;
            
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, colorStr); 
            g.addColorStop(1, 'rgba(0,0,0,0)');
            
            ctx.fillStyle = g;
            
            // Tile wrapping (draw 9 times to ensure seamless tiling)
            for(let dx = -1; dx <= 1; dx++) {
                for(let dy = -1; dy <= 1; dy++) {
                    ctx.save();
                    ctx.translate(dx * size, dy * size);
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                }
            }
        }
    };

    // Layer 1: Macro Waves (Red) - Large, sparse
    drawNoiseLayer('rgba(150, 0, 0, 0.4)', 20, 100, 250);
    
    // Layer 2: Turbulence (Green) - Small, dense
    drawNoiseLayer('rgba(0, 150, 0, 0.3)', 60, 30, 80);
    
    // Layer 3: Variance (Blue) - Tiny detail
    drawNoiseLayer('rgba(0, 0, 150, 0.3)', 100, 10, 40);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    
    return texture;
  }

  initTrailSystem() {
    // 1. Render Target for storing trails
    const res = 1024; // Higher resolution for cleaner trails
    this.trailTarget = new THREE.WebGLRenderTarget(res, res, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RedFormat,
      type: THREE.HalfFloatType,
    });
    
    this.uniforms.uTrailMap.value = this.trailTarget.texture;

    // 2. Scene for the trail rendering
    this.trailScene = new THREE.Scene();
    
    // 3. Camera covering the terrain
    // Terrain is 200x200, centered at 0,0
    const halfSize = 100;
    this.trailCamera = new THREE.OrthographicCamera(-halfSize, halfSize, halfSize, -halfSize, 0.1, 100);
    this.trailCamera.position.set(0, 50, 0);
    this.trailCamera.lookAt(0, 0, 0);
    // Orient camera so Top of texture maps to -Z (Standard UV mapping alignment)
    this.trailCamera.up.set(0, 0, -1);

    // 4. "Brush" - The player's footprint influence
    // Smaller brush for accurate feet position
    const brushGeo = new THREE.PlaneGeometry(0.8, 0.8); 
    const brushMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255, 255, 255, 1.0)'); 
    grd.addColorStop(0.4, 'rgba(255, 255, 255, 0.8)');
    grd.addColorStop(1, 'rgba(0, 0, 0, 0)'); 
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
    
    const brushTex = new THREE.CanvasTexture(canvas);
    brushMat.map = brushTex;
    brushMat.alphaMap = brushTex;
    
    this.brush = new THREE.Mesh(brushGeo, brushMat);
    this.brush.rotation.x = -Math.PI / 2;
    this.trailScene.add(this.brush);
    
    // 5. "Fade" Quad
    const fadeGeo = new THREE.PlaneGeometry(200, 200);
    const fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.005, // Very slow fade to allow wind recovery mechanic to shine
      side: THREE.DoubleSide
    });
    this.fadeQuad = new THREE.Mesh(fadeGeo, fadeMat);
    this.fadeQuad.rotation.x = -Math.PI / 2;
    this.fadeQuad.position.y = -0.1;
    this.trailScene.add(this.fadeQuad);
  }

  createGeometry() {
    const grassHeight = 0.8; 
    const grassWidth = 0.015; // Thinner as requested
    const segments = 2;       
    
    const grassGeo = new THREE.PlaneGeometry(grassWidth, grassHeight, 1, segments);
    grassGeo.translate(0, grassHeight / 2, 0); 
    
    // Tapering
    const posAttribute = grassGeo.attributes.position;
    for (let i = 0; i < posAttribute.count; i++) {
      const y = posAttribute.getY(i);
      const hNorm = y / grassHeight;
      const widthScale = 1.0 - Math.pow(hNorm, 2.0); // Sharper taper
      const x = posAttribute.getX(i);
      posAttribute.setX(i, x * widthScale); 
      
      const curve = Math.pow(hNorm, 2.0) * 0.3;
      posAttribute.setZ(i, posAttribute.getZ(i) - curve);
    }
    grassGeo.computeVertexNormals();
    return grassGeo;
  }

  initMaterials() {
    const patchShader = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      
      shader.vertexShader = `
        uniform float uTime;
        uniform vec3 uPlayerPos;
        uniform vec3 uPlayerVel;
        uniform sampler2D uTrailMap;
        uniform float uTerrainSize;
        uniform sampler2D uWindNoise;
        uniform float uWindTime;
        uniform float uWindStrength;
        varying float vHeight;
        varying vec3 vWorldPosition;
        ${shader.vertexShader}
      `;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        GRASS_VERTEX_LOGIC
      );
    };

    // 1. Visible Material
    this.baseMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, 
      roughness: 1.0, 
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false,
      onBeforeCompile: (shader) => {
        patchShader(shader);
        
        shader.fragmentShader = `
          varying float vHeight;
          varying vec3 vInstanceColor;
        ` + shader.fragmentShader;
        
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `
          vec3 bottomColor = vec3(0.01, 0.08, 0.01);
          vec3 topColor = vec3(0.2, 0.5, 0.1);
          
          vec3 finalColor = mix(bottomColor, topColor, vHeight);
          finalColor *= vInstanceColor;
          finalColor *= smoothstep(-0.1, 0.3, vHeight); // AO
          diffuseColor.rgb = finalColor;
          `
        );
        
        // Inject vInstanceColor support in vertex for main material
        shader.vertexShader = shader.vertexShader.replace(
           'varying vec3 vWorldPosition;',
           'varying vec3 vWorldPosition; varying vec3 vInstanceColor;'
        );
        shader.vertexShader = shader.vertexShader.replace(
           'vHeight = uv.y;',
           'vHeight = uv.y; vInstanceColor = instanceColor;'
        );
      }
    });

    // 2. Depth Material (For Shadows)
    this.baseDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      onBeforeCompile: (shader) => {
        patchShader(shader);
      }
    });
  }

  initChunks() {
    const terrainSize = 200;
    const chunkSize = 25; // Break into 8x8 grid (64 chunks)
    const density = 250; // High density (approx 2x previous)
    
    // Pre-allocate temporary objects
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    
    // Create chunks
    for (let x = -terrainSize/2; x < terrainSize/2; x += chunkSize) {
      for (let z = -terrainSize/2; z < terrainSize/2; z += chunkSize) {
        this.createChunk(x, z, chunkSize, density, dummy, color);
      }
    }
  }

  createChunk(startX, startZ, size, density, dummy, color) {
    const area = size * size;
    const totalInstances = Math.floor(area * density);
    
    // Split into Low LOD (base) and High LOD (detail)
    // Low LOD: 20% of grass, always visible in medium range
    // High LOD: 80% of grass, only visible in close range
    const baseCount = Math.floor(totalInstances * 0.2);
    const detailCount = totalInstances - baseCount;

    const meshBase = new THREE.InstancedMesh(this.baseGeometry, this.baseMaterial, baseCount);
    const meshDetail = new THREE.InstancedMesh(this.baseGeometry, this.baseMaterial, detailCount);
    
    // Enable shadows
    meshBase.castShadow = true;
    meshBase.receiveShadow = true;
    meshDetail.castShadow = true; // Warning: Expensive
    meshDetail.receiveShadow = true;
    
    // Assign custom depth material for correct shadow deformation
    meshBase.customDepthMaterial = this.baseDepthMaterial;
    meshDetail.customDepthMaterial = this.baseDepthMaterial;

    this.fillMesh(meshBase, 0, baseCount, startX, startZ, size, dummy, color);
    this.fillMesh(meshDetail, 0, detailCount, startX, startZ, size, dummy, color);

    this.group.add(meshBase);
    this.group.add(meshDetail);
    
    // Store chunk info for LOD updates
    this.chunks.push({
      center: new THREE.Vector3(startX + size/2, 0, startZ + size/2),
      meshBase: meshBase,
      meshDetail: meshDetail,
      size: size
    });
  }

  fillMesh(mesh, offset, count, startX, startZ, size, dummy, color) {
    let idx = 0;
    while(idx < count) {
      const x = startX + Math.random() * size;
      const z = startZ + Math.random() * size;
      
      const y = this.getTerrainHeight(x, z);
      dummy.position.set(x, y, z);
      
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.rotation.x = (Math.random() - 0.5) * 0.2; 
      dummy.rotation.z = (Math.random() - 0.5) * 0.2;

      // Region based height
      const region = noise(x * 0.015, z * 0.015); 
      const tallFactor = THREE.MathUtils.smoothstep(region, 0.0, 0.8);
      
      // Height variation
      const hScale = 0.4 + Math.random() * 0.4 + (tallFactor * 0.8);
      
      // Thinner stands
      const wScale = 0.5 + Math.random() * 0.5;
      
      dummy.scale.set(wScale, hScale, wScale);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      
      // Color Variation
      const colorNoise = noise(x * 0.05, z * 0.05); 
      if (colorNoise > 0.6) {
         color.setHex(0x7a8a4b); 
      } else {
         const v = 0.5 + Math.random() * 0.4;
         color.setRGB(v * 0.6, v * 0.9, v * 0.4); 
      }
      mesh.setColorAt(idx, color);
      
      idx++;
    }
  }

  update(time, dt, playerPosition, camera, sunDirection, lodHigh = 128, lodLow = 256) {
    this.uniforms.uTime.value = time;
    
    // --- Wind Dynamics ---
    // Calculate global wind variance (Gusts and Lulls)
    // Combine two sine waves for irregular "breathing" of the wind
    const cycle1 = Math.sin(time * 0.1);         // Slow 60s cycle
    const cycle2 = Math.sin(time * 0.4 + 2.0);   // Faster 15s cycle
    
    // Combined normalized -1 to 1
    const rawWind = (cycle1 + cycle2 * 0.5) / 1.5; 
    
    // Map to strength multiplier:
    // Calm (0.2) to Stormy (1.6)
    // Use smoothstep to make the 'states' linger slightly
    const normWind = THREE.MathUtils.smoothstep(rawWind, -0.8, 0.8);
    const targetStrength = THREE.MathUtils.lerp(0.1, 1.8, normWind);
    
    // Smoothly transition current strength (inertia)
    this.currentWindStrength += (targetStrength - this.currentWindStrength) * dt * 0.8;
    
    // Accumulate wind time based on current speed
    // This makes the waves move faster when wind is stronger
    this.windTime += dt * this.currentWindStrength;

    this.uniforms.uWindTime.value = this.windTime;
    this.uniforms.uWindStrength.value = this.currentWindStrength;

    if (playerPosition) {
      this.brush.position.set(playerPosition.x, 0, playerPosition.z);

      if (this.renderer && this.trailTarget) {
        const currentRenderTarget = this.renderer.getRenderTarget();
        const currentAutoClear = this.renderer.autoClear;
        
        this.renderer.setRenderTarget(this.trailTarget);
        this.renderer.autoClear = false; 
        
        this.renderer.render(this.trailScene, this.trailCamera);
        
        this.renderer.setRenderTarget(currentRenderTarget);
        this.renderer.autoClear = currentAutoClear;
      }
      
      this.uniforms.uPlayerPos.value.copy(playerPosition);
      
      if (dt > 0.0001) {
        const vel = new THREE.Vector3()
          .subVectors(playerPosition, this.lastPlayerPos)
          .divideScalar(dt);
        this.uniforms.uPlayerVel.value.copy(vel);
      }
      this.lastPlayerPos.copy(playerPosition);
    }

    if (playerPosition && camera) {
      this.updateLOD(playerPosition, camera, lodHigh, lodLow);
    }
  }

  updateLOD(playerPosition, camera, distHigh, distLow) {
    const px = playerPosition.x;
    const pz = playerPosition.z;

    // Get camera forward direction projected on XZ
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    fwd.y = 0;
    fwd.normalize();
    const fx = fwd.x;
    const fz = fwd.z;

    // Calculate LOD Oval Centers
    // We shift the center of the LOD area forward so the "edge" is just behind the camera
    // and the majority of the detail is projected in front.
    
    // High Detail: Shift significantly forward
    const shiftHigh = distHigh * 0.75; 
    const chx = px + fx * shiftHigh;
    const chz = pz + fz * shiftHigh;

    // Low Detail: Shift moderately
    const shiftLow = distLow * 0.4;
    const clx = px + fx * shiftLow;
    const clz = pz + fz * shiftLow;

    // Aspect ratio > 1.0 compresses the width, making the field an oval
    const aspect = 1.4; 

    for (let chunk of this.chunks) {
      const cx = chunk.center.x;
      const cz = chunk.center.z;

      // --- High LOD Check ---
      const dxH = cx - chx;
      const dzH = cz - chz;
      
      // Project vector onto forward axis
      const fDistH = dxH * fx + dzH * fz;
      
      // Project vector onto right axis (rejection)
      const sxH = dxH - fx * fDistH;
      const szH = dzH - fz * fDistH;
      
      // Elliptical distance: (forward)^2 + (side * aspect)^2
      const dSqH = fDistH*fDistH + (sxH*sxH + szH*szH) * aspect * aspect;
      
      const isHigh = dSqH < (distHigh * distHigh);

      if (isHigh) {
        chunk.meshBase.visible = true;
        chunk.meshDetail.visible = true;
        continue;
      }

      // --- Low LOD Check ---
      const dxL = cx - clx;
      const dzL = cz - clz;
      
      const fDistL = dxL * fx + dzL * fz;
      const sxL = dxL - fx * fDistL;
      const szL = dzL - fz * fDistL;
      
      // Slightly wider oval for low LOD background
      const aspectLow = aspect * 0.8;
      const dSqL = fDistL*fDistL + (sxL*sxL + szL*szL) * aspectLow * aspectLow;
      
      const isLow = dSqL < (distLow * distLow);

      chunk.meshBase.visible = isLow;
      chunk.meshDetail.visible = false;
    }
  }
}

