import { gl, WEBGL_draw_buffers, canvas } from '../init';
import { mat4, vec4 } from 'gl-matrix';
import { loadShaderProgram, renderFullscreenQuad, renderHalfscreenTriangle } from '../utils';
import { NUM_LIGHTS } from '../scene';
import toTextureVert from '../shaders/deferredToTexture.vert.glsl';
import toTextureFrag from '../shaders/deferredToTexture.frag.glsl';
import QuadVertSource from '../shaders/quad.vert.glsl';
import fsSource from '../shaders/deferred.frag.glsl.js';

import horizontalSource from '../shaders/horizontalBlur.frag.glsl';
import verticalfsSource from '../shaders/verticalBlur.frag.glsl';

import extHDRSource from '../shaders/extractHDR.frag.glsl';
import lensFlareSource from '../shaders/lensflare.frag.glsl.js';
import TextureBuffer from './textureBuffer';
import ClusteredRenderer from './clustered';
import { MAX_LIGHTS_PER_CLUSTER } from './clustered';
import { SPECIAL_NEARPLANE } from './clustered';

export const NUM_GBUFFERS = 2;

export default class ClusteredDeferredEffectRenderer extends ClusteredRenderer {
  constructor(xSlices, ySlices, zSlices) {
    super(xSlices, ySlices, zSlices);
    
    this.setupDrawBuffers(canvas.width, canvas.height);

    this._weight = [];
    this._weight[0] = 0.2270270270; this._weight[1] = 0.1945945946; this._weight[2] = 0.1216216216; this._weight[3] = 0.0540540541; this._weight[4] = 0.0162162162;

    this._gapH = [];
    this._gapH[0] = 0.0; this._gapH[1] = 1.4117647 / this._width; this._gapH[2] = 3.2941176 / this._width; this._gapH[3] = 5.1764706 / this._width; this._gapH[4] = 7.0588235 / this._width;

    this._gapV = [];
    this._gapV[0] = 0.0; this._gapV[1] = 1.4117647 / this._height; this._gapV[2] = 3.2941176 /this._height; this._gapV[3] = 5.1764706 / this._height; this._gapV[4] = 7.0588235 / this._height;
    
    // Create a texture to store light data
    this._lightTexture = new TextureBuffer(NUM_LIGHTS, 8);
    
    this._progCopy = loadShaderProgram(toTextureVert, toTextureFrag, {
      uniforms: ['u_viewProjectionMatrix', 'u_viewMatrix', 'u_colmap', 'u_normap'],
      attribs: ['a_position', 'a_normal', 'a_uv'],
    });

    this._progShade = loadShaderProgram(QuadVertSource, fsSource({
      numLights: NUM_LIGHTS,
      numGBuffers: NUM_GBUFFERS,
      num_xSlices: xSlices,
      num_ySlices: ySlices,
      num_zSlices: zSlices,
      special_near: SPECIAL_NEARPLANE,
      num_maxLightsPerCluster: MAX_LIGHTS_PER_CLUSTER
    }), {
      uniforms: ['u_viewProjectionMatrix', 'u_viewMatrix', 'u_invProjectionMatrix', 'u_invViewProjectionMatrix', 'u_depthBuffer', 'u_gbuffers[0]', 'u_gbuffers[1]', 'u_lightbuffer', 'u_clusterbuffer', 'u_screenInfobuffer'],
      attribs: ['a_uv'],
    });

    this._HDR = loadShaderProgram(QuadVertSource, extHDRSource, {
      uniforms: ['u_viewProjectionMatrix', 'u_sceneTexture'],
      attribs: ['a_uv'],
    });

    this._HorizonBlur = loadShaderProgram(QuadVertSource, horizontalSource, {
      uniforms: ['u_viewProjectionMatrix', 'u_sceneTexture', 'u_wieght', 'u_gap'],
      attribs: ['a_uv'],
    });

    this._VerticalBlur = loadShaderProgram(QuadVertSource, verticalfsSource, {
      uniforms: ['u_viewProjectionMatrix', 'u_sceneTexture', 'u_wieght', 'u_gap'],
      attribs: ['a_uv'],
    });

    this._effectShade = loadShaderProgram(QuadVertSource, lensFlareSource({}), {
      uniforms: ['u_viewProjectionMatrix', 'u_viewMatrix', 'u_dirtTexture', 'u_starburstTexture', 'u_sceneTexture', 'u_screenInfobuffer', 'u_HDR'],
      attribs: ['a_uv'],
    });

    this._projectionMatrix = mat4.create();
    this._viewMatrix = mat4.create();
    this._viewProjectionMatrix = mat4.create();
    this._invProjectionMatrix = mat4.create();
    this._invViewProjectionMatrix = mat4.create();


  }

  setupDrawBuffers(width, height) {
    this._width = width;
    this._height = height;

    this._fbo = gl.createFramebuffer();
    
    //Create, bind, and store a depth target texture for the FBO
    this._depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._depthTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this._depthTex, 0);    

    // Create, bind, and store "color" target textures for the FBO
    this._gbuffers = new Array(NUM_GBUFFERS);
    let attachments = new Array(NUM_GBUFFERS);
    for (let i = 0; i < NUM_GBUFFERS; i++) {
      attachments[i] = WEBGL_draw_buffers[`COLOR_ATTACHMENT${i}_WEBGL`];
      this._gbuffers[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._gbuffers[i]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
      gl.bindTexture(gl.TEXTURE_2D, null);

      gl.framebufferTexture2D(gl.FRAMEBUFFER, attachments[i], gl.TEXTURE_2D, this._gbuffers[i], 0);      
    }

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) != gl.FRAMEBUFFER_COMPLETE) {
      throw "Framebuffer incomplete";
    }

    // Tell the WEBGL_draw_buffers extension which FBO attachments are
    // being used. (This extension allows for multiple render targets.)
    WEBGL_draw_buffers.drawBuffersWEBGL(attachments);


    this._fbo2 = gl.createFramebuffer();
    this._Lighting = gl.createTexture();   
    gl.bindTexture(gl.TEXTURE_2D, this._Lighting);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null); 

    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo2);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._Lighting, 0);


    this._fbo3 = gl.createFramebuffer();
    this._HDRteX = gl.createTexture();   
    gl.bindTexture(gl.TEXTURE_2D, this._HDRteX);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null); 

    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo3);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._HDRteX, 0);



    this._fbo4 = gl.createFramebuffer();
    this._horizontalText = gl.createTexture();   
    gl.bindTexture(gl.TEXTURE_2D, this._horizontalText);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null); 

    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo4);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._horizontalText, 0);



    this._fbo5 = gl.createFramebuffer();
    this._verticalText = gl.createTexture();   
    gl.bindTexture(gl.TEXTURE_2D, this._verticalText);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null); 

    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo5);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._verticalText, 0);





    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width, height) {
    this._width = width;
    this._height = height;

    gl.bindTexture(gl.TEXTURE_2D, this._depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
    for (let i = 0; i < NUM_GBUFFERS; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this._gbuffers[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(camera, scene) {
    if (canvas.width != this._width || canvas.height != this._height) {
      this.resize(canvas.width, canvas.height);
    }

    // Update the camera matrices
    camera.updateMatrixWorld();
    mat4.invert(this._viewMatrix, camera.matrixWorld.elements);
    mat4.copy(this._projectionMatrix, camera.projectionMatrix.elements);
    mat4.multiply(this._viewProjectionMatrix, this._projectionMatrix, this._viewMatrix);
    mat4.invert(this._invProjectionMatrix, this._projectionMatrix);
    mat4.invert(this._invViewProjectionMatrix, this._viewProjectionMatrix);

    // Render to the whole screen
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Bind the framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);

    // Clear the frame
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Use the shader program to copy to the draw buffers
    gl.useProgram(this._progCopy.glShaderProgram);

    // Upload the camera matrix
    gl.uniformMatrix4fv(this._progCopy.u_viewProjectionMatrix, false, this._viewProjectionMatrix);
    gl.uniformMatrix4fv(this._progCopy.u_viewMatrix, false, this._viewMatrix);

    // Draw the scene. This function takes the shader program so that the model's textures can be bound to the right inputs
    scene.draw(this._progCopy);
    
    // Update the buffer used to populate the texture packed with light data
    for (let i = 0; i < NUM_LIGHTS; ++i) {
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 0) + 0] = scene.lights[i].position[0];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 0) + 1] = scene.lights[i].position[1];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 0) + 2] = scene.lights[i].position[2];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 0) + 3] = scene.lights[i].radius;

      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 1) + 0] = scene.lights[i].color[0];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 1) + 1] = scene.lights[i].color[1];
      this._lightTexture.buffer[this._lightTexture.bufferIndex(i, 1) + 2] = scene.lights[i].color[2];
    }
    // Update the light texture
    this._lightTexture.update();

    // Update the clusters for the frame
    this.updateClusters(camera, this._viewMatrix, scene);

    // Bind the default null framebuffer which is the screen

    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo2);
    //gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this._depthTex, 0);

    //gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Clear the frame
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Use this shader program
    gl.useProgram(this._progShade.glShaderProgram);

    // TODO: Bind any other shader inputs
    // Set the light texture as a uniform input to the shader
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._lightTexture.glTexture);
    gl.uniform1i(this._progShade.u_lightbuffer, 0);

     // Set the cluster texture as a uniform input to the shader
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._clusterTexture.glTexture);
    gl.uniform1i(this._progShade.u_clusterbuffer, 1);


    //DepthBuffer
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._depthTex);
    gl.uniform1i(this._progShade.u_depthBuffer, 2);


    gl.uniformMatrix4fv(this._progShade.u_viewProjectionMatrix, false, this._viewProjectionMatrix);
    gl.uniformMatrix4fv(this._progShade.u_viewMatrix, false, this._viewMatrix);
    gl.uniformMatrix4fv(this._progShade.u_invProjectionMatrix, false, this._invProjectionMatrix);
    gl.uniformMatrix4fv(this._progShade.u_invViewProjectionMatrix, false, this._invViewProjectionMatrix);
    gl.uniform4f(this._progShade.u_screenInfobuffer, canvas.width, canvas.height, camera.near, camera.far);

    // Bind g-buffers
    const firstGBufferBinding = 3; // You may have to change this if you use other texture slots
    for (let i = 0; i < NUM_GBUFFERS; i++) {
      gl.activeTexture(gl[`TEXTURE${i + firstGBufferBinding}`]);
      gl.bindTexture(gl.TEXTURE_2D, this._gbuffers[i]);
      gl.uniform1i(this._progShade[`u_gbuffers[${i}]`], i + firstGBufferBinding);
    }

    //renderFullscreenQuad(this._progShade);
    renderHalfscreenTriangle(this._progShade);

  
    //Extract HDR part
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo3);

    gl.useProgram(this._HDR.glShaderProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._Lighting);
    gl.uniform1i(this._HDR.u_sceneTexture, 0);

    // Upload the camera matrix
    gl.uniformMatrix4fv(this._HDR.u_viewProjectionMatrix, false, this._viewProjectionMatrix);

    //renderFullscreenQuad(this._HDR);
    renderHalfscreenTriangle(this._HDR);


    //Horizontal Blur
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo4);

    gl.useProgram(this._HorizonBlur.glShaderProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._HDRteX);
    gl.uniform1i(this._HorizonBlur.u_sceneTexture, 0);

    // Upload the camera matrix
    gl.uniformMatrix4fv(this._HorizonBlur.u_viewProjectionMatrix, false, this._viewProjectionMatrix);
    gl.uniform1fv(this._HorizonBlur.u_wieght, this._weight);
    gl.uniform1fv(this._HorizonBlur.u_gap, this._gapH);

    //renderFullscreenQuad(this._HorizonBlur);
    renderHalfscreenTriangle(this._HorizonBlur);



    //Vertical Blur
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo5);

    gl.useProgram(this._VerticalBlur.glShaderProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._horizontalText);
    gl.uniform1i(this._VerticalBlur.u_sceneTexture, 0);

    // Upload the camera matrix
    gl.uniformMatrix4fv(this._VerticalBlur.u_viewProjectionMatrix, false, this._viewProjectionMatrix);
    gl.uniform1fv(this._VerticalBlur.u_wieght, this._weight);
    gl.uniform1fv(this._VerticalBlur.u_gap, this._gapV);

    //renderFullscreenQuad(this._VerticalBlur);
    renderHalfscreenTriangle(this._VerticalBlur);

    
    // Bind the default null framebuffer which is the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Use this shader program
    gl.useProgram(this._effectShade.glShaderProgram);
    
    scene.drawEffect(this._effectShade);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._Lighting);
    gl.uniform1i(this._effectShade.u_sceneTexture, 2);


    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this._verticalText);
    gl.uniform1i(this._effectShade.u_HDR, 3);

    

    // Upload the camera matrix
    gl.uniformMatrix4fv(this._effectShade.u_viewProjectionMatrix, false, this._viewProjectionMatrix);
    gl.uniformMatrix4fv(this._effectShade.u_viewMatrix, false, this._viewMatrix);
    
    gl.uniform4f(this._effectShade.u_screenInfobuffer, 1.0 / canvas.width, 1.0 / canvas.height, camera.near, camera.far);

    //renderFullscreenQuad(this._effectShade);
    renderHalfscreenTriangle(this._effectShade);
   

  }
};
