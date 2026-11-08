//! The OS's own popup menu for the selects (speed, date and the Settings
//! choices), like a macOS pop-up button: system font, checkmark on the
//! current item, the current item placed under the pointer.
//!
//! `popup` opens the menu from the main queue, just after the current
//! update, and gives back the chosen index as a task, so the app keeps
//! drawing (and the video playing) while the menu is open.

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSControlStateValueOn, NSEvent, NSMenu, NSMenuItem};
    use objc2_foundation::NSString;
    use std::sync::atomic::{AtomicIsize, Ordering};

    /// The tag of the item picked during the current popup (-1: none).
    static CHOSEN: AtomicIsize = AtomicIsize::new(-1);

    define_class!(
        // Receives the menu items' action.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "SentryStudioMenuTarget"]
        struct MenuTarget;

        impl MenuTarget {
            #[unsafe(method(choose:))]
            fn choose(&self, sender: &NSMenuItem) {
                CHOSEN.store(sender.tag(), Ordering::Relaxed);
            }
        }
    );

    impl MenuTarget {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            unsafe { msg_send![Self::alloc(mtm), init] }
        }
    }

    pub fn run(items: &[String], selected: Option<usize>) -> Option<usize> {
        let mtm = MainThreadMarker::new()?;
        let target = MenuTarget::new(mtm);
        let target_obj: &AnyObject = &target;
        let menu = NSMenu::new(mtm);
        let mut current = None;
        for (i, title) in items.iter().enumerate() {
            let item = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    NSMenuItem::alloc(mtm),
                    &NSString::from_str(title),
                    Some(sel!(choose:)),
                    &NSString::from_str(""),
                )
            };
            unsafe { item.setTarget(Some(target_obj)) };
            item.setTag(i as isize);
            if selected == Some(i) {
                item.setState(NSControlStateValueOn);
                current = Some(item.clone());
            }
            menu.addItem(&item);
        }
        CHOSEN.store(-1, Ordering::Relaxed);
        // Like a popup button: the current item opens under the pointer.
        menu.popUpMenuPositioningItem_atLocation_inView(current.as_deref(), NSEvent::mouseLocation(), None);
        let chosen = CHOSEN.swap(-1, Ordering::Relaxed);
        (chosen >= 0).then_some(chosen as usize)
    }
}

/// Opens the menu (`items`, the current one ticked) at the pointer; the
/// task ends with the chosen index, or None when it's closed.
#[cfg(target_os = "macos")]
pub fn popup(items: Vec<String>, selected: Option<usize>) -> iced::Task<Option<usize>> {
    let (tx, rx) = iced::futures::channel::oneshot::channel();
    dispatch2::DispatchQueue::main().exec_async(move || {
        let _ = tx.send(imp::run(&items, selected));
    });
    iced::Task::future(async move { rx.await.ok().flatten() })
}

/// Whether this OS has the popup (macOS). Elsewhere a click on a select
/// moves to its next choice.
pub const AVAILABLE: bool = cfg!(target_os = "macos");

#[cfg(not(target_os = "macos"))]
pub fn popup(_items: Vec<String>, _selected: Option<usize>) -> iced::Task<Option<usize>> {
    iced::Task::none()
}

/// The task for a menu whose choice becomes `message`.
pub fn choose<M: Send + 'static>(items: Vec<String>, selected: Option<usize>, message: impl Fn(usize) -> M + Send + 'static) -> iced::Task<M> {
    popup(items, selected).then(move |chosen| match chosen {
        Some(i) => iced::Task::done(message(i)),
        None => iced::Task::none(),
    })
}
