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

  // --- WIND SYSTEM ---
  // Slower time scale for more realistic, less jittery movement
  float windTime = uTime * 0.15; 
  vec2 targetWindDir = normalize(uWindDir); 
  
  // Layer 1: Macro Gusts (Red Channel) - Moves along wind dir
  vec2 gustUV = worldPos.xz * 0.003 + targetWindDir * windTime;
  float gustNoise = texture2D(uWindNoise, gustUV).r;
  
  // Layer 2: Turbulence (Green Channel) - Higher frequency
  vec2 turbUV = worldPos.xz * 0.02 + targetWindDir * windTime * 2.0;
  float turbNoise = texture2D(uWindNoise, turbUV).g;
  
  // Layer 3: Variance
  float noiseVar = texture2D(uWindNoise, worldPos.xz * 0.01).b;

  // Composite Wind Intensity
  float windIntensity = gustNoise * 0.7 + turbNoise * 0.3;
  
  // Dynamic Bursts (Procedural) - Occasional strong gusts
  float burst = sin(dot(worldPos.xz, targetWindDir) * 0.02 - uTime * 0.5);
  burst = smoothstep(0.6, 1.0, burst);
  windIntensity = clamp(windIntensity + burst * 0.4, 0.0, 1.0);

  // --- PLAYER INTERACTION ---
  vec2 mapUV = (worldPos.xz + (uTerrainSize * 0.5)) / uTerrainSize;
  mapUV = clamp(mapUV, 0.0, 1.0);
  mapUV.y = 1.0 - mapUV.y; 
  float trailValue = texture2D(uTrailMap, mapUV).r;
  
  float dist = distance(worldPos.xz, uPlayerPos.xz);
  float radius = 0.45; 
  float immediatePush = 1.0 - smoothstep(0.0, radius, dist);
  immediatePush = pow(immediatePush, 2.0); // Sharper falloff
  
  // Combine trail and player
  float totalCrush = max(trailValue, immediatePush);

  // --- WIND RESTORATION (Fix Trail) ---
  // When wind is strong, it forces grass to bend with wind, overriding the crush
  // Logic: if wind > threshold, reduce crush effect significantly
  float restoration = smoothstep(0.2, 0.8, windIntensity);
  
  // The crush effect is dampened by restoration
  // If restoration is 1.0 (strong wind), effectiveCrush becomes small
  float effectiveCrush = totalCrush * (1.0 - restoration * 0.8);
  effectiveCrush = clamp(effectiveCrush, 0.0, 1.0);

  // --- DISPLACEMENT ---
  // Restore flexibility if lifted by wind
  float stiffness = 1.0 - effectiveCrush;
  float flex = pow(vHeight, 2.0) * stiffness;
  
  // Wind Force
  vec3 windDisp = vec3(targetWindDir.x, 0.0, targetWindDir.y);
  windDisp *= windIntensity * 1.5 * flex; // Wind displacement magnitude
  
  // Flutter (High frequency low amplitude) - slower than before
  float flutter = sin(uTime * 2.0 + worldPos.x) * 0.05 * flex;
  windDisp.y += flutter;
  
  // Trample/Crush Displacement
  // Push away from player or randomize for trails
  vec2 pushDir = normalize(worldPos.xz - uPlayerPos.xz);
  if (length(worldPos.xz - uPlayerPos.xz) < 0.001) pushDir = vec2(1.0, 0.0);
  
  // Use noise for trail direction variance so it doesn't look like a combed carpet
  vec2 noiseDir = vec2(noiseVar - 0.5, turbNoise - 0.5);
  noiseDir = normalize(noiseDir);
  
  vec2 interactDir = mix(noiseDir, pushDir, immediatePush);
  vec3 crushDisp = vec3(interactDir.x, 0.0, interactDir.y) * effectiveCrush * vHeight;
  
  // Combine
  vec3 totalDisp = windDisp + crushDisp;
  
  // Project to Local Space
  vec3 iRight = normalize(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
  vec3 iUp    = normalize(vec3(instanceMatrix[1][0], instanceMatrix[1][1], instanceMatrix[1][2]));
  vec3 iFwd   = normalize(vec3(instanceMatrix[2][0], instanceMatrix[2][1], instanceMatrix[2][2]));
  
  transformed.x += dot(totalDisp, iRight);
  transformed.y += dot(totalDisp, iUp);
  transformed.z += dot(totalDisp, iFwd);
  
  // Flattening (Y-axis)
  transformed.y -= effectiveCrush * 0.7 * vHeight;

  // --- NORMALS ---
  #ifndef USE_SHADOWMAP
     // Bias normals upwards during wind lift to catch light
     vec3 bendBias = normalize(totalDisp + vec3(0.0, 1.0, 0.0));
     objectNormal = normalize(mix(objectNormal, bendBias, 0.4));
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
      uWindDir: { value: new THREE.Vector2(1, 0) }
    };
    
    this.renderer = renderer;
    this.scene = scene;
    this.getTerrainHeight = getTerrainHeight;
    this.lastPlayerPos = new THREE.Vector3(0, -100, 0);
    this.windAngle = 0;
    
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
    // Create a canvas to draw noise
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    // Fill background with mid-level noise
    ctx.fillStyle = '#404040'; 
    ctx.fillRect(0, 0, size, size);
    
    // Helper to draw channel specific noise
    const drawNoiseLayer = (colorStr, count, minR, maxR) => {
        for (let i = 0; i < count; i++) {
            const x = Math.random() * size;
            const y = Math.random() * size;
            const r = Math.random() * (maxR - minR) + minR;
            
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, colorStr); 
            g.addColorStop(1, 'rgba(0,0,0,0)');
            
            // Draw with 'lighter' to additively blend channels
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = g;
            
            // Tile wrapping
            const offsets = [[0,0], [size,0], [-size,0], [0,size], [0,-size]];
            offsets.forEach(off => {
                 ctx.beginPath();
                 ctx.arc(x + off[0], y + off[1], r, 0, Math.PI * 2);
                 ctx.fill();
            });
        }
    };

    // Red Channel: Large Gusts
    drawNoiseLayer('rgba(100, 0, 0, 0.5)', 40, 50, 150);
    
    // Green Channel: Turbulence
    drawNoiseLayer('rgba(0, 100, 0, 0.5)', 80, 20, 60);
    
    // Blue Channel: Variance
    drawNoiseLayer('rgba(0, 0, 100, 0.5)', 60, 30, 90);
    
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
      opacity: 0.01, // Slower fade for permanent trails, wind handles temporary lift
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
        uniform vec2 uWindDir;
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
    
    // Dynamic Wind Direction
    // Change angle slowly using Perlin-ish logic (sum of sines)
    this.windAngle += dt * 0.05 + (Math.sin(time * 0.1) * dt * 0.1); 
    const wx = Math.cos(this.windAngle);
    const wz = Math.sin(this.windAngle);
    this.uniforms.uWindDir.value.set(wx, wz);
    
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

