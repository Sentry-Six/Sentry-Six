/**
 * Draggable Panels
 * Allows dashboard and map panels to be dragged around the screen
 */

// Drag offsets for each panel
const dragOffsets = new Map();
// Track if a drag actually occurred (mouse moved) to prevent click events
const dragOccurred = new Map();
// Track panels that need viewport constraint checking
const constrainedPanels = new Set();

/**
 * Initialize draggable behavior for panels
 * @param {HTMLElement[]} panels - Array of panel elements to make draggable
 */
export function initDraggablePanels(panels) {
    const validPanels = panels.filter(Boolean);
    
    validPanels.forEach(panel => {
        // Already wired? A dragOffsets entry is created exactly once per panel
        // below, so its presence means the listeners exist. This function is
        // re-invoked on every dashboard layout/movability toggle — without
        // this guard, duplicate document-level mousemove/mouseup handlers
        // accumulate for the session (N forced layouts per mousemove).
        if (dragOffsets.has(panel)) {
            constrainedPanels.add(panel);
            return;
        }

        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let hasMoved = false;

        dragOffsets.set(panel, { x: 0, y: 0 });

        panel.addEventListener('mousedown', (e) => {
            // Don't drag if clicking on interactive elements
            if (e.target.closest('button, input, select, a')) return;
            
            isDragging = true;
            hasMoved = false;
            const offset = dragOffsets.get(panel);
            startX = e.clientX - offset.x;
            startY = e.clientY - offset.y;
            panel.style.cursor = 'grabbing';
            e.preventDefault();
            e.stopPropagation();
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            e.preventDefault();
            const offset = dragOffsets.get(panel);
            let newX = e.clientX - startX;
            let newY = e.clientY - startY;
            
            // Check if mouse actually moved (more than a few pixels)
            if (Math.abs(newX - offset.x) > 2 || Math.abs(newY - offset.y) > 2) {
                hasMoved = true;
            }
            
            // Clamp to viewport bounds (like support chat)
            const rect = panel.getBoundingClientRect();
            // Base position = current rendered position minus current offset
            const baseLeft = rect.left - offset.x;
            const baseTop = rect.top - offset.y;
            const panelWidth = rect.width;
            const panelHeight = rect.height;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const controlsBarHeight = 60; // Height of the bottom controls bar
            
            // Clamp so panel stays fully within viewport
            const minX = -baseLeft;
            const maxX = viewportWidth - panelWidth - baseLeft;
            const minY = -baseTop;
            const maxY = viewportHeight - panelHeight - controlsBarHeight - baseTop;
            
            newX = Math.max(minX, Math.min(newX, maxX));
            newY = Math.max(minY, Math.min(newY, maxY));
            
            offset.x = newX;
            offset.y = newY;
            // Use setProperty with !important for compact dashboard to override CSS !important rules
            if (panel.classList.contains('dashboard-vis-compact')) {
                panel.style.setProperty('transform', `translate3d(${offset.x}px, ${offset.y}px, 0)`, 'important');
            } else {
                panel.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
            }
        });
        
        document.addEventListener('mouseup', (e) => {
            if (isDragging) {
                isDragging = false;
                panel.style.cursor = 'grab';
                
                // If we actually dragged, prevent the click event from firing
                if (hasMoved) {
                    dragOccurred.set(panel, true);
                    // Prevent click event from propagating
                    e.preventDefault();
                    e.stopPropagation();
                    // Clear the flag after a short delay to allow click events again
                    setTimeout(() => {
                        dragOccurred.delete(panel);
                    }, 100);
                }
            }
        });
        
        // Prevent click event if a drag occurred
        panel.addEventListener('click', (e) => {
            if (dragOccurred.has(panel)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        }, true); // Use capture phase to catch it early
        
        // Add all draggable panels to constrained panels set for resize handling
        constrainedPanels.add(panel);
    });
    
    // Initialize resize handler if not already set up
    if (!window._draggablePanelsResizeHandler) {
        let resizeTimeout;
        window._draggablePanelsResizeHandler = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                constrainPanelsToViewport();
            }, 100);
        };
        window.addEventListener('resize', window._draggablePanelsResizeHandler);
    }
}

/**
 * Constrain draggable panels to stay within viewport bounds
 * If a panel goes out of bounds, reset it to the closest valid position
 */
function constrainPanelsToViewport() {
    constrainedPanels.forEach(panel => {
        if (!panel.isConnected) {
            constrainedPanels.delete(panel);
            return;
        }
        
        // Skip hidden panels
        if (panel.classList.contains('hidden') || panel.classList.contains('user-hidden')) {
            return;
        }
        
        const offset = dragOffsets.get(panel);
        if (!offset) return;
        
        const rect = panel.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Get panel dimensions
        const panelWidth = rect.width;
        const panelHeight = rect.height;
        
        // Check if panel is significantly out of bounds (less than 50px visible)
        const minVisiblePx = 50;
        const isOutOfBounds = 
            rect.right < minVisiblePx || 
            rect.left > viewportWidth - minVisiblePx ||
            rect.bottom < minVisiblePx || 
            rect.top > viewportHeight - minVisiblePx;
        
        if (isOutOfBounds) {
            // Reset to closest corner/edge position
            // Determine which corner is closest based on current position
            const centerX = rect.left + panelWidth / 2;
            const centerY = rect.top + panelHeight / 2;
            const viewportCenterX = viewportWidth / 2;
            const viewportCenterY = viewportHeight / 2;
            
            // Calculate target position (closest corner with margin)
            const margin = 20;
            let targetLeft, targetTop;
            
            // Horizontal: left or right side
            if (centerX < viewportCenterX) {
                // Closer to left side
                targetLeft = margin;
            } else {
                // Closer to right side
                targetLeft = viewportWidth - panelWidth - margin;
            }
            
            // Vertical: top or bottom
            if (centerY < viewportCenterY) {
                // Closer to top
                targetTop = margin;
            } else {
                // Closer to bottom - account for controls bar
                targetTop = viewportHeight - panelHeight - 80;
            }
            
            // Get the CSS base position
            const computedStyle = window.getComputedStyle(panel);
            let baseLeft = 0;
            let baseTop = 0;
            
            // Handle panels positioned with 'right' instead of 'left'
            if (computedStyle.right !== 'auto' && computedStyle.left === 'auto') {
                const rightVal = parseInt(computedStyle.right) || 20;
                baseLeft = viewportWidth - panelWidth - rightVal;
            } else {
                baseLeft = parseInt(computedStyle.left) || 0;
            }
            baseTop = parseInt(computedStyle.top) || 0;
            
            // Calculate new offset to achieve target position
            offset.x = targetLeft - baseLeft;
            offset.y = targetTop - baseTop;
            
            // Apply the corrected transform
            if (panel.classList.contains('dashboard-vis-compact')) {
                panel.style.setProperty('transform', `translate3d(${offset.x}px, ${offset.y}px, 0)`, 'important');
            } else {
                panel.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
            }
        }
    });
}

/**
 * Reset a panel's position to its original location
 * @param {HTMLElement} panel - Panel element to reset
 */
export function resetPanelPosition(panel) {
    if (dragOffsets.has(panel)) {
        dragOffsets.set(panel, { x: 0, y: 0 });
        // Use setProperty with !important for compact dashboard to override CSS !important rules
        if (panel.classList.contains('dashboard-vis-compact')) {
            panel.style.setProperty('transform', 'translate3d(0, 0, 0)', 'important');
        } else {
            panel.style.transform = '';
        }
    }
}
