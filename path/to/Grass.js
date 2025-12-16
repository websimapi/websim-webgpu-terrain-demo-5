import * as THREE from 'three';
import { TrailSystem } from './TrailSystem.js';
import { patchGrassMaterial } from './GrassMaterial.js';
import { noise, generateWindNoiseTexture } from './GrassUtils.js';

export class GrassSystem {
  constructor(scene, getTerrainHeight, renderer) {
    // Generate Wind Noise Texture
    const windTex = generateWindNoiseTexture();

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
    this.trailSystem = new TrailSystem();
    this.uniforms.uTrailMap.value = this.trailSystem.texture;
    
    // Initialize Geometry and Material reused by all chunks
    this.baseGeometry = this.createGeometry();
    this.initMaterials();

    // Create Grass Chunks
    this.chunks = [];
    this.initChunks();
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
    // 1. Visible Material
    this.baseMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, 
      roughness: 1.0, 
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false,
    });
    patchGrassMaterial(this.baseMaterial, this.uniforms, false);

    // 2. Depth Material (For Shadows)
    this.baseDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    });
    patchGrassMaterial(this.baseDepthMaterial, this.uniforms, true);
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
    this.currentWindStrength += (targetStrength - this.currentWindStrength) * dt * 0.2;
    
    // Accumulate wind time based on current speed
    // This makes the waves move faster when wind is stronger
    this.windTime += dt * this.currentWindStrength;

    this.uniforms.uWindTime.value = this.windTime;
    this.uniforms.uWindStrength.value = this.currentWindStrength;

    // Update Trail System
    if (playerPosition) {
      this.trailSystem.update(this.renderer, playerPosition);

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