/**
 * Layout Lab - Drag and drop canvas for camera positioning
 * Implements magnet cards with snap-to-edge and snap-to-sibling functionality
 */

import { t } from '../lib/i18n.js';

// Get translated camera labels
function getCameraLabel(camera) {
    const labels = {
        'left_pillar': t('ui.cameras.leftPillar'),
        'front': t('ui.cameras.front'),
        'right_pillar': t('ui.cameras.rightPillar'),
        'left_repeater': t('ui.cameras.leftRepeater'),
        'back': t('ui.cameras.back'),
        'right_repeater': t('ui.cameras.rightRepeater')
    };
    return labels[camera] || camera;
}

// Window resize handler from the most recent initLayoutLab() call.
// initLayoutLab runs on every export-modal open; without removing the
// previous handler, debounced resize closures accumulate for the session.
let activeResizeHandler = null;

// Layout state: stores position and size for each camera
export const layoutState = {
    cameras: new Map(), // camera -> { x, y, width, height }
    canvasWidth: 0,     // Canvas width (set on init, 16:9 aspect ratio)
    canvasHeight: 0,    // Canvas height
    snapThreshold: 10,  // Pixels threshold for snapping
    availableCameras: null // Set of available cameras (null = all cameras available)
};

/**
 * Set available cameras for the layout lab
 * Used to filter cameras for HW3 vehicles (4-cam systems without pillars)
 * @param {Set<string>} cameras - Set of available camera names
 */
export function setAvailableCameras(cameras) {
    layoutState.availableCameras = cameras;
}

/**
 * Initialize the layout lab canvas
 */
export function initLayoutLab() {
    const canvas = document.getElementById('layoutCanvas');
    // Scope strictly to the simple-export camera grid. The Advanced Editor's
    // toggles (#aeCameraToggles) reuse the same .option-card/input[data-camera]
    // markup, so an unscoped query would also grab the AE checkboxes and keep
    // cards alive that the user unchecked here.
    const toggles = document.querySelectorAll('#exportCameraToggles input[data-camera]');
    
    if (!canvas) return;
    
    // Clear any existing cards and reset layout state when initializing
    canvas.querySelectorAll('.layout-card').forEach(card => card.remove());
    layoutState.cameras.clear();
    
    // Set canvas dimensions (16:9 aspect ratio)
    const container = canvas.parentElement;
    
    // Function to calculate and set canvas dimensions
    const calculateCanvasDimensions = (retryCount = 0) => {
        // Container has 40px padding (20px on each side), so we need to account for that
        const containerWidth = container.offsetWidth;
        
        // If container width is 0 or invalid, retry (max 10 retries)
        if ((!containerWidth || containerWidth < 100) && retryCount < 10) {
            requestAnimationFrame(() => calculateCanvasDimensions(retryCount + 1));
            return;
        }
        
        // Force a layout recalculation by accessing offsetWidth
        container.offsetWidth; // Force reflow
        
        const availableWidth = containerWidth - 40; // Account for padding
        layoutState.canvasWidth = Math.min(600, Math.max(400, availableWidth)); // Clamp between 400-600px
        layoutState.canvasHeight = layoutState.canvasWidth * (9 / 16);
        canvas.style.width = `${layoutState.canvasWidth}px`;
        canvas.style.height = `${layoutState.canvasHeight}px`;
        
        // Wait one more frame to ensure canvas size is applied
        requestAnimationFrame(() => {
            // Verify canvas dimensions are actually applied
            const actualWidth = canvas.offsetWidth;
            const actualHeight = canvas.offsetHeight;
            
            if (actualWidth > 0 && actualHeight > 0) {
                layoutState.canvasWidth = actualWidth;
                layoutState.canvasHeight = actualHeight;
            }
            
            // Initialize default layout for checked cameras
            updateCanvas();
        });
    };
    
    // Use multiple requestAnimationFrame calls to ensure DOM is fully laid out
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(calculateCanvasDimensions);
        });
    });
    
    // Listen for checkbox changes
    toggles.forEach(toggle => {
        // Remove existing listeners to avoid duplicates
        const newToggle = toggle.cloneNode(true);
        toggle.parentNode.replaceChild(newToggle, toggle);
        newToggle.addEventListener('change', () => {
            updateCanvas();
        });
    });
    
    // Handle window resize (debounced). Replace the handler from any previous
    // init so repeated export-modal opens don't stack resize listeners.
    if (activeResizeHandler) {
        window.removeEventListener('resize', activeResizeHandler);
    }
    let resizeTimeout;
    activeResizeHandler = () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const containerWidth = container.offsetWidth - 40;
            layoutState.canvasWidth = Math.min(600, Math.max(400, containerWidth)); // Clamp between 400-600px
            layoutState.canvasHeight = layoutState.canvasWidth * (9 / 16);
            canvas.style.width = `${layoutState.canvasWidth}px`;
            canvas.style.height = `${layoutState.canvasHeight}px`;
            updateCanvasPositions();
        }, 100);
    };
    window.addEventListener('resize', activeResizeHandler);
}

/**
 * Update canvas based on checked cameras
 */
function updateCanvas() {
    const canvas = document.getElementById('layoutCanvas');
    if (!canvas || layoutState.canvasWidth === 0) return; // Wait for canvas to be initialized
    
    const checkedCameras = Array.from(document.querySelectorAll('#exportCameraToggles input[data-camera]:checked'))
        .map(cb => cb.dataset.camera);
    
    // Check if we're going from 0 cameras to having cameras (reset all positions)
    const hadCameras = layoutState.cameras.size > 0;
    const hasCameras = checkedCameras.length > 0;
    const shouldResetPositions = !hadCameras && hasCameras;
    
    // Remove cards for unchecked cameras
    canvas.querySelectorAll('.layout-card').forEach(card => {
        const camera = card.dataset.camera;
        if (!checkedCameras.includes(camera)) {
            card.remove();
            layoutState.cameras.delete(camera);
        }
    });
    
    // If resetting positions, clear all existing positions
    if (shouldResetPositions) {
        layoutState.cameras.clear();
        canvas.querySelectorAll('.layout-card').forEach(card => card.remove());
    }
    
    // Calculate default card size based on canvas dimensions (for 3x2 grid)
    const padding = 16; // Padding around the canvas edge
    const cols = 3; // Standard 3 columns
    const rows = 2; // Standard 2 rows
    
    const availableWidth = layoutState.canvasWidth - (padding * 2);
    const availableHeight = layoutState.canvasHeight - (padding * 2);
    
    // Calculate card size that would fit in a 3x2 grid (all cards use this same size)
    const cardWidth = Math.floor(availableWidth / cols);
    const cardHeight = Math.floor(availableHeight / rows);
    
    // Define the standard camera order for 3x2 grid layout
    const STANDARD_CAMERA_ORDER = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
    
    // Add cards for newly checked cameras with default layout
    checkedCameras.forEach((camera) => {
        let card = canvas.querySelector(`.layout-card[data-camera="${camera}"]`);
        const needsReset = shouldResetPositions || !layoutState.cameras.has(camera);
        
        if (!card || needsReset) {
            // Remove existing card if present (for reset)
            if (card) {
                card.remove();
                layoutState.cameras.delete(camera);
            }
            
            // Find index in standard order (for default 3x2 positioning)
            const standardIndex = STANDARD_CAMERA_ORDER.indexOf(camera);
            const index = standardIndex >= 0 ? standardIndex : checkedCameras.indexOf(camera);
            
            // Default grid layout (3 columns) using standard camera order
            const row = Math.floor(index / cols);
            const col = index % cols;
            
            // Calculate grid dimensions with standard card size (always use full 3x2 grid)
            const totalGridWidth = cardWidth * cols;
            const totalGridHeight = cardHeight * rows;
            
            // Center the grid within the canvas
            const offsetX = padding + (layoutState.canvasWidth - totalGridWidth - (padding * 2)) / 2;
            const offsetY = padding + (layoutState.canvasHeight - totalGridHeight - (padding * 2)) / 2;
            
            // Position cards with centering offsets (based on standard grid position)
            const x = Math.round(offsetX + (col * cardWidth));
            const y = Math.round(offsetY + (row * cardHeight));
            
            // Ensure position stays within canvas bounds
            const finalX = Math.max(0, Math.min(x, layoutState.canvasWidth - cardWidth));
            const finalY = Math.max(0, Math.min(y, layoutState.canvasHeight - cardHeight));
            
            layoutState.cameras.set(camera, {
                x: finalX,
                y: finalY,
                width: cardWidth,
                height: cardHeight
            });
            
            createCard(camera, finalX, finalY, cardWidth, cardHeight);
        } else {
            // Existing card - ensure it uses default size (resize if needed)
            const layout = layoutState.cameras.get(camera);
            if (layout) {
                // Check if card size differs from calculated default (allowing 1px tolerance for rounding)
                if (Math.abs(layout.width - cardWidth) > 1 || Math.abs(layout.height - cardHeight) > 1) {
                    layout.width = cardWidth;
                    layout.height = cardHeight;
                    
                    // Ensure position is still valid with new size
                    layout.x = Math.max(0, Math.min(layout.x, layoutState.canvasWidth - cardWidth));
                    layout.y = Math.max(0, Math.min(layout.y, layoutState.canvasHeight - cardHeight));
                    
                    // Update card element
                    card.style.width = `${cardWidth}px`;
                    card.style.height = `${cardHeight}px`;
                    card.style.left = `${layout.x}px`;
                    card.style.top = `${layout.y}px`;
                }
            }
        }
    });
    
    updateCanvasPositions();
}

/**
 * Update card positions on canvas (for canvas resize)
 */
function updateCanvasPositions() {
    const canvas = document.getElementById('layoutCanvas');
    if (!canvas || layoutState.canvasWidth === 0 || layoutState.canvasHeight === 0) return;
    
    canvas.querySelectorAll('.layout-card').forEach(card => {
        const camera = card.dataset.camera;
        const layout = layoutState.cameras.get(camera);
        if (layout) {
            // Ensure positions are within canvas bounds
            let x = Math.max(0, Math.min(layout.x, Math.max(0, layoutState.canvasWidth - layout.width)));
            let y = Math.max(0, Math.min(layout.y, Math.max(0, layoutState.canvasHeight - layout.height)));
            
            // Update stored position if it was adjusted
            if (x !== layout.x || y !== layout.y) {
                layout.x = x;
                layout.y = y;
            }
            
            card.style.left = `${x}px`;
            card.style.top = `${y}px`;
            card.style.width = `${layout.width}px`;
            card.style.height = `${layout.height}px`;
        }
    });
}

/**
 * Create a camera card element
 */
function createCard(camera, x, y, width, height) {
    const canvas = document.getElementById('layoutCanvas');
    if (!canvas) return;
    
    const card = document.createElement('div');
    card.className = 'layout-card';
    card.dataset.camera = camera;
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.style.width = `${width}px`;
    card.style.height = `${height}px`;
    
    // Label
    const label = document.createElement('div');
    label.className = 'card-label';
    label.textContent = getCameraLabel(camera);
    card.appendChild(label);
    
    // Make draggable
    makeDraggable(card, camera);
    
    canvas.appendChild(card);
}

/**
 * Make a card draggable with snap functionality
 */
function makeDraggable(card, camera) {
    let isDragging = false;
    let startX, startY, initialX, initialY;
    let snapLines = { x: null, y: null };
    
    const handleMouseDown = (e) => {
        isDragging = true;
        card.classList.add('dragging');
        e.preventDefault();
        
        const rect = card.getBoundingClientRect();
        const canvasRect = card.parentElement.getBoundingClientRect();
        
        startX = e.clientX;
        startY = e.clientY;
        initialX = rect.left - canvasRect.left;
        initialY = rect.top - canvasRect.top;
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };
    
    const handleMouseMove = (e) => {
        if (!isDragging) return;
        
        const canvasRect = card.parentElement.getBoundingClientRect();
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        
        let newX = initialX + deltaX;
        let newY = initialY + deltaY;
        
        // Constrain to canvas bounds (ensure cards stay fully within canvas)
        const layout = layoutState.cameras.get(camera);
        if (!layout || layoutState.canvasWidth === 0 || layoutState.canvasHeight === 0) return;
        
        // Get actual canvas dimensions from DOM
        const canvasElement = card.parentElement;
        const actualCanvasWidth = canvasElement.offsetWidth || layoutState.canvasWidth;
        const actualCanvasHeight = canvasElement.offsetHeight || layoutState.canvasHeight;
        
        const maxX = Math.max(0, actualCanvasWidth - layout.width);
        const maxY = Math.max(0, actualCanvasHeight - layout.height);
        
        // Strict bounds: cards must stay fully within canvas (with 0 as minimum)
        newX = Math.max(0, Math.min(newX, maxX));
        newY = Math.max(0, Math.min(newY, maxY));
        
        // Snap detection
        const snapResult = detectSnap(camera, newX, newY, layout.width, layout.height);
        
        if (snapResult.snapped) {
            card.classList.add('snapping');
            // Apply snapped position
            newX = snapResult.x;
            newY = snapResult.y;
        } else {
            card.classList.remove('snapping');
        }
        
        // Final strict bounds check before applying (clamp to valid range)
        newX = Math.max(0, Math.min(newX, maxX));
        newY = Math.max(0, Math.min(newY, maxY));
        
        card.style.left = `${newX}px`;
        card.style.top = `${newY}px`;
    };
    
    const handleMouseUp = () => {
        if (!isDragging) return;
        isDragging = false;
        card.classList.remove('dragging', 'snapping');
        
        // Save final position (ensure it's within bounds)
        const layout = layoutState.cameras.get(camera);
        
        // Get actual canvas dimensions from DOM
        const canvasElement = card.parentElement;
        const actualCanvasWidth = canvasElement.offsetWidth || layoutState.canvasWidth;
        const actualCanvasHeight = canvasElement.offsetHeight || layoutState.canvasHeight;
        const maxX = Math.max(0, actualCanvasWidth - layout.width);
        const maxY = Math.max(0, actualCanvasHeight - layout.height);
        
        // Get current position from style (more reliable than getBoundingClientRect)
        const currentX = parseFloat(card.style.left) || layout.x;
        const currentY = parseFloat(card.style.top) || layout.y;
        
        // Clamp to valid bounds
        let finalX = Math.max(0, Math.min(currentX, maxX));
        let finalY = Math.max(0, Math.min(currentY, maxY));
        
        layout.x = finalX;
        layout.y = finalY;
        
        // Update card position to match saved position (ensure it's correct)
        card.style.left = `${finalX}px`;
        card.style.top = `${finalY}px`;
        
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    };
    
    card.addEventListener('mousedown', handleMouseDown);
}

/**
 * Detect snap positions (edge and sibling)
 */
function detectSnap(camera, x, y, width, height) {
    const threshold = layoutState.snapThreshold;
    let snappedX = x;
    let snappedY = y;
    let snapped = false;
    
    // Validate bounds first
    if (layoutState.canvasWidth === 0 || layoutState.canvasHeight === 0) {
        return { x: snappedX, y: snappedY, snapped: false };
    }
    
    const canvasWidth = layoutState.canvasWidth;
    const canvasHeight = layoutState.canvasHeight;
    const maxX = Math.max(0, canvasWidth - width);
    const maxY = Math.max(0, canvasHeight - height);
    
    // Calculate card center for center snapping
    const cardCenterX = x + width / 2;
    const cardCenterY = y + height / 2;
    const canvasCenterX = canvasWidth / 2;
    const canvasCenterY = canvasHeight / 2;
    
    // Snap to canvas edges or center (only if it keeps card within bounds)
    if (Math.abs(x) < threshold && x >= 0) {
        snappedX = 0;
        snapped = true;
    } else {
        const rightEdge = x + width;
        const canvasRight = canvasWidth;
        if (Math.abs(rightEdge - canvasRight) < threshold && x <= maxX) {
            snappedX = maxX;
            snapped = true;
        }
        // Snap to horizontal center of canvas
        else if (Math.abs(cardCenterX - canvasCenterX) < threshold) {
            snappedX = canvasCenterX - width / 2;
            snapped = true;
        }
    }
    
    if (Math.abs(y) < threshold && y >= 0) {
        snappedY = 0;
        snapped = true;
    } else {
        const bottomEdge = y + height;
        const canvasBottom = canvasHeight;
        if (Math.abs(bottomEdge - canvasBottom) < threshold && y <= maxY) {
            snappedY = maxY;
            snapped = true;
        }
        // Snap to vertical center of canvas
        else if (Math.abs(cardCenterY - canvasCenterY) < threshold) {
            snappedY = canvasCenterY - height / 2;
            snapped = true;
        }
    }
    
    // Snap to sibling cards
    for (const [otherCamera, otherLayout] of layoutState.cameras.entries()) {
        if (otherCamera === camera) continue;
        
        // Calculate centers for center snapping
        const thisCenterX = x + width / 2;
        const thisCenterY = y + height / 2;
        const otherCenterX = otherLayout.x + otherLayout.width / 2;
        const otherCenterY = otherLayout.y + otherLayout.height / 2;
        
        // Snap to left edge
        if (Math.abs(x - (otherLayout.x + otherLayout.width)) < threshold) {
            snappedX = otherLayout.x + otherLayout.width;
            snapped = true;
        }
        // Snap to right edge
        else if (Math.abs((x + width) - otherLayout.x) < threshold) {
            snappedX = otherLayout.x - width;
            snapped = true;
        }
        // Snap to horizontal center (this card's center aligns with other card's center)
        else if (Math.abs(thisCenterX - otherCenterX) < threshold) {
            snappedX = otherCenterX - width / 2;
            snapped = true;
        }
        
        // Snap to top edge
        if (Math.abs(y - (otherLayout.y + otherLayout.height)) < threshold) {
            snappedY = otherLayout.y + otherLayout.height;
            snapped = true;
        }
        // Snap to bottom edge
        else if (Math.abs((y + height) - otherLayout.y) < threshold) {
            snappedY = otherLayout.y - height;
            snapped = true;
        }
        // Snap to vertical center (this card's center aligns with other card's center)
        else if (Math.abs(thisCenterY - otherCenterY) < threshold) {
            snappedY = otherCenterY - height / 2;
            snapped = true;
        }
        
        // Snap horizontally aligned (top edges)
        if (Math.abs(y - otherLayout.y) < threshold) {
            snappedY = otherLayout.y;
            snapped = true;
        }
        // Snap horizontally aligned (bottom edges)
        else if (Math.abs((y + height) - (otherLayout.y + otherLayout.height)) < threshold) {
            snappedY = otherLayout.y + otherLayout.height - height;
            snapped = true;
        }
        
        // Snap vertically aligned (left edges)
        if (Math.abs(x - otherLayout.x) < threshold) {
            snappedX = otherLayout.x;
            snapped = true;
        }
        // Snap vertically aligned (right edges)
        else if (Math.abs((x + width) - (otherLayout.x + otherLayout.width)) < threshold) {
            snappedX = otherLayout.x + otherLayout.width - width;
            snapped = true;
        }
    }
    
    // Ensure snapped positions are within bounds
    snappedX = Math.max(0, Math.min(snappedX, maxX));
    snappedY = Math.max(0, Math.min(snappedY, maxY));
    
    return { x: snappedX, y: snappedY, snapped };
}

/**
 * Get layout data for export (positions and sizes for each camera)
 */
export function getLayoutData() {
    const layoutData = {};
    for (const [camera, layout] of layoutState.cameras.entries()) {
        layoutData[camera] = {
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height
        };
    }
    // Also return canvas dimensions for proper scaling
    return {
        cameras: layoutData,
        canvasWidth: layoutState.canvasWidth,
        canvasHeight: layoutState.canvasHeight
    };
}

