/* ===== app.js — extracted from app.html (build-time inlined, in place) ===== */
/* ----- Colour Tuner: hex/hsl math + picker UI ----- */
/* Reads earlier app.html global PALETTE_SEEDS. Owns colState. ----- */

// Colour state
const colState = { A: '#888888', B: '#444444', nameA: '', nameB: '' }

function hexToHSL(hex) {
  let r = parseInt(hex.slice(1,3),16)/255
  let g = parseInt(hex.slice(3,5),16)/255
  let b = parseInt(hex.slice(5,7),16)/255
  const max=Math.max(r,g,b), min=Math.min(r,g,b)
  let h,s,l=(max+min)/2
  if(max===min){ h=s=0 } else {
    const d=max-min; s=l>0.5?d/(2-max-min):d/(max+min)
    switch(max){ case r:h=((g-b)/d+(g<b?6:0))/6;break; case g:h=((b-r)/d+2)/6;break; case b:h=((r-g)/d+4)/6;break }
  }
  return [Math.round(h*360), Math.round(s*100), Math.round(l*100)]
}

function hslToHex(h,s,l) {
  s/=100; l/=100
  const a=s*Math.min(l,1-l)
  const f=n=>{ const k=(n+h/30)%12; const c=l-a*Math.max(Math.min(k-3,9-k,1),-1); return Math.round(255*c).toString(16).padStart(2,'0') }
  return `#${f(0)}${f(8)}${f(4)}`
}

function hexToName(hex) {
  // Return a human-readable description based on HSL
  const [h,s,l] = hexToHSL(hex)
  let hue='', sat='', lit=''
  if(s<10) hue='grey'
  else if(h<15||h>=345) hue='red'
  else if(h<40) hue='orange'
  else if(h<65) hue='yellow'
  else if(h<150) hue='green'
  else if(h<195) hue='cyan'
  else if(h<255) hue='blue'
  else if(h<290) hue='purple'
  else if(h<345) hue='pink'
  if(l<12) return 'near black'
  if(l>92) return 'near white'
  lit = l<30?'dark ':l>70?'light ':''
  sat = s<25?'muted ':s>75?'vivid ':''
  return `${lit}${sat}${hue}`
}

function updatePickerUI(slot, hex) {
  colState[slot] = hex
  const [h,s,l] = hexToHSL(hex)
  document.getElementById('col'+slot+'H').value = h
  document.getElementById('col'+slot+'S').value = s
  document.getElementById('col'+slot+'L').value = l
  document.getElementById('col'+slot+'Hv').value = h
  document.getElementById('col'+slot+'Sv').value = s
  document.getElementById('col'+slot+'Lv').value = l
  document.getElementById('col'+slot+'Hex').textContent = hex.toUpperCase()
  document.getElementById('col'+slot+'Label').textContent = colState['name'+slot] || hexToName(hex)
  document.getElementById('swatch'+slot).style.background = hex
  document.getElementById('preview'+slot).style.background = hex
  updateTunerSummary()
}

function updateTunerSummary() {
  const nameA = (El.colALabel || document.getElementById('colALabel'))?.textContent || ''
  const nameB = (El.colBLabel || document.getElementById('colBLabel'))?.textContent || ''
  const modA  = (El.modA || document.getElementById('modA'))?.value || ''
  const modB  = (El.modB || document.getElementById('modB'))?.value || ''
  const partA = modA ? `${modA} ${nameA} (${colState.A.toUpperCase()})` : `${nameA} (${colState.A.toUpperCase()})`
  const partB = modB ? `${modB} ${nameB} (${colState.B.toUpperCase()})` : `${nameB} (${colState.B.toUpperCase()})`
  const el = El.tunerSummary || document.getElementById('tunerSummary')
  if (el) el.textContent = `Prompt: "${partA} and ${partB}"`
}

function onHSLChange(slot) {
  const h = +document.getElementById('col'+slot+'H').value
  const s = +document.getElementById('col'+slot+'S').value
  const l = +document.getElementById('col'+slot+'L').value
  const hex = hslToHex(h,s,l)
  colState[slot] = hex
  colState['name'+slot] = ''
  document.getElementById('col'+slot+'Hv').value = h
  document.getElementById('col'+slot+'Sv').value = s
  document.getElementById('col'+slot+'Lv').value = l
  document.getElementById('col'+slot+'Hex').textContent = hex.toUpperCase()
  document.getElementById('col'+slot+'Label').textContent = hexToName(hex)
  document.getElementById('swatch'+slot).style.background = hex
  document.getElementById('preview'+slot).style.background = hex
  updateTunerSummary()
  driveSaveCurrentDebounced()
}

function onValueInput(slot, channel) {
  const inputEl = document.getElementById('col'+slot+channel+'v')
  const max = channel === 'H' ? 360 : 100
  let val = Math.max(0, Math.min(max, parseInt(inputEl.value) || 0))
  inputEl.value = val
  document.getElementById('col'+slot+channel).value = val
  const h = +document.getElementById('col'+slot+'Hv').value
  const s = +document.getElementById('col'+slot+'Sv').value
  const l = +document.getElementById('col'+slot+'Lv').value
  const hex = hslToHex(h,s,l)
  colState[slot] = hex
  colState['name'+slot] = ''
  document.getElementById('col'+slot+'Hex').textContent = hex.toUpperCase()
  document.getElementById('col'+slot+'Label').textContent = hexToName(hex)
  document.getElementById('swatch'+slot).style.background = hex
  document.getElementById('preview'+slot).style.background = hex
  updateTunerSummary()
  driveSaveCurrentDebounced()
}

function onPaletteChange() {
  const val = document.getElementById('colourSel').value
  const tuner = document.getElementById('colourTuner')
  if (!val) { tuner.style.display='none'; driveSaveCurrentDebounced(); return }
  tuner.style.display = 'block'
  const seed = PALETTE_SEEDS[val]
  if (seed) {
    colState.nameA = seed[2]; colState.nameB = seed[3]
    document.getElementById('colALabel').textContent = seed[2].toUpperCase()
    document.getElementById('colBLabel').textContent = seed[3].toUpperCase()
    updatePickerUI('A', seed[0])
    updatePickerUI('B', seed[1])
  } else {
    colState.nameA = 'Colour 1'; colState.nameB = 'Colour 2'
    document.getElementById('colALabel').textContent = 'COLOUR 1'
    document.getElementById('colBLabel').textContent = 'COLOUR 2'
    updatePickerUI('A', '#888888')
    updatePickerUI('B', '#444444')
  }
  driveSaveCurrentDebounced()
}

function getColourString() {
  const palette = document.getElementById('colourSel').value
  const tuner = document.getElementById('colourTuner')
  if (!palette || tuner.style.display === 'none') return palette
  const nameA = document.getElementById('colALabel').textContent
  const nameB = document.getElementById('colBLabel').textContent
  const modA = document.getElementById('modA').value
  const modB = document.getElementById('modB').value
  const partA = modA ? `${modA} ${nameA} (${colState.A.toUpperCase()})` : `${nameA} (${colState.A.toUpperCase()})`
  const partB = modB ? `${modB} ${nameB} (${colState.B.toUpperCase()})` : `${nameB} (${colState.B.toUpperCase()})`
  return `${palette}, fine-tuned to ${partA} and ${partB}`
}
