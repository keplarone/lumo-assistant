//! Ordering with the user's apps (Uber Eats, DoorDash, Instacart, Amazon and more).
//!
//! Lumo opens the app in the user's own browser, where they are signed in, and fills the cart on
//! screen with control_computer. It always stops before paying: cart_ready_for_user ends the input
//! session and hands the screen back, and after that Lumo cannot control the computer again in this
//! task. Starting an order needs a native confirmation that lists what will be ordered. Lumo never
//! types card numbers (control_computer refuses them) or passwords.
//!
//! On plans without computer control, start_order opens the app with the order list copied, like
//! prepare_checkout_handoff.

use super::computer::{begin_session, end_session, STOP_SHORTCUT};
use super::{object_schema, ToolCtx, ToolOutput, TypedTool};
use crate::agent::events::ActionPreview;
use crate::core::Core;
use crate::error::{invalid, LumoError, Result};
use crate::integrations::apps;
use crate::policy::Risk;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct OrderSession {
    pub app: &'static str,
    /// The cart was handed to the user. Lumo may not control the computer again in this run.
    pub handed_off: bool,
}

/// Called before every control_computer call.
pub fn check_control(core: &Core, run_id: &str) -> Result<()> {
    match core.pending.orders.lock().get(run_id) {
        Some(o) if o.handed_off => Err(LumoError::Denied(format!(
            "The {} cart is with the user now, so Lumo won't use the mouse or keyboard again in this task. The user places the order themselves.",
            apps::find(o.app).map(|a| a.name).unwrap_or("order")
        ))),
        _ => Ok(()),
    }
}

pub struct StartOrder;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartOrderInput {
    /// An app id (listed in the turn context).
    pub app: String,
    /// What to search for in the app, e.g. a restaurant or product name.
    #[serde(default)]
    pub search: Option<String>,
    pub items: Vec<OrderItem>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderItem {
    pub name: String,
    pub quantity: u32,
}

fn order_text(app: &str, i: &StartOrderInput) -> String {
    let mut s = format!("Order on {app}\n");
    if let Some(q) = i.search.as_deref().filter(|q| !q.trim().is_empty()) {
        s.push_str(&format!("From: {}\n", q.trim()));
    }
    for it in &i.items {
        s.push_str(&format!("{} × {}\n", it.quantity, it.name));
    }
    s
}

fn can_control(ctx: &ToolCtx) -> bool {
    crate::plans::current(&ctx.core).computer_control
}

#[async_trait]
impl TypedTool for StartOrder {
    type Input = StartOrderInput;
    const NAME: &'static str = "start_order";
    const DESCRIPTION: &'static str = "Order food, groceries, products, rides or tables in one of the user's apps (ids in context). After the user confirms, fill the cart on screen with control_computer, then call cart_ready_for_user at checkout.";
    fn schema(&self) -> Value {
        object_schema(
            json!({
                "app": {"type": "string"},
                "search": {"type": "string"},
                "items": {"type": "array", "minItems": 1, "maxItems": 30, "items": object_schema(json!({
                    "name": {"type": "string"}, "quantity": {"type": "integer", "minimum": 1, "maximum": 99}
                }), &["name", "quantity"])}
            }),
            &["app", "items"],
        )
    }
    fn check(&self, _ctx: &ToolCtx, i: &StartOrderInput) -> Result<()> {
        apps::find(&i.app)?;
        if i.items.is_empty()
            || i.items.len() > 30
            || i.items.iter().any(|it| it.quantity == 0 || it.quantity > 99 || it.name.trim().is_empty())
        {
            return Err(invalid("give 1 to 30 items, each with a name and a quantity from 1 to 99"));
        }
        Ok(())
    }
    fn risk(&self, _: &ToolCtx, _: &StartOrderInput) -> Risk {
        Risk::Sensitive
    }
    fn label(&self, i: &StartOrderInput) -> String {
        format!("Starting your order on {}", apps::find(&i.app).map(|a| a.name).unwrap_or("the app"))
    }
    fn preview(&self, ctx: &ToolCtx, i: &StartOrderInput) -> Result<ActionPreview> {
        let app = apps::find(&i.app)?;
        let mut details = vec![("App".to_string(), app.name.to_string())];
        if let Some(q) = i.search.as_deref().filter(|q| !q.trim().is_empty()) {
            details.push(("From".into(), crate::util::preview(q, 80)));
        }
        for it in &i.items {
            details.push((format!("{} ×", it.quantity), crate::util::preview(&it.name, 80)));
        }
        details.push(("Deliver to".into(), format!("The address in your {} account", app.name)));
        details.push(("You pay".into(), format!("Only when you tap the final button in {} yourself", app.name)));
        if can_control(ctx) {
            Ok(ActionPreview {
                title: format!("Let Lumo fill your {} cart", app.name),
                details,
                warning: Some(format!(
                    "Lumo will open {} in your browser and use your mouse and keyboard to add these items, then stop at checkout so you can check the total and place the order. Lumo never types passwords or card numbers. Take back control any time with {STOP_SHORTCUT}.",
                    app.name
                )),
            })
        } else {
            Ok(ActionPreview {
                title: format!("Open {} with your order list", app.name),
                details,
                warning: Some(format!(
                    "Your plan doesn't include screen control, so Lumo copies the list to your clipboard and opens {} for you to add the items and order.",
                    app.name
                )),
            })
        }
    }
    async fn run(&self, ctx: &ToolCtx, i: StartOrderInput) -> Result<ToolOutput> {
        let app = apps::find(&i.app)?;
        let url = apps::start_url(app, i.search.as_deref());
        if !apps::owns(app, &url) {
            return Err(invalid("that page does not belong to the app"));
        }
        let signed_in = apps::is_connected(&ctx.core, app.id);
        let items: Vec<apps::RecentItem> =
            i.items.iter().map(|it| apps::RecentItem { name: it.name.trim().into(), quantity: it.quantity }).collect();
        if let Err(e) = apps::remember_order(&ctx.core, app.id, i.search.as_deref(), &items) {
            log::warn!("could not remember the order: {e}");
        }
        let data = json!({"app": app.id, "name": app.name, "url": url, "status": "filling"});
        if !can_control(ctx) {
            ctx.core.platform.clipboard_write(&order_text(app.name, &i))?;
            ctx.core.platform.open_url(&url)?;
            return Ok(ToolOutput {
                text: format!(
                    "The user confirmed. {} opened in their browser and the order list is on their clipboard. Their plan has no screen control, so the user adds the items and orders themselves. Nothing is ordered yet.",
                    app.name
                ),
                summary: format!("Opened {} with your list", app.name),
                data: Some(json!({"app": app.id, "name": app.name, "url": url, "status": "handed_off"})),
                ..Default::default()
            });
        }
        ctx.core.platform.open_url(&url)?;
        ctx.core.pending.orders.lock().insert(ctx.run_id.clone(), OrderSession { app: app.id, handed_off: false });
        // The user allowed screen control for this order in the dialog they just confirmed.
        begin_session(ctx);
        let sign_in = if signed_in {
            String::new()
        } else {
            format!(" The user hasn't told Lumo they are signed in to {}. If a sign-in page shows, call cart_ready_for_user with stopped_for \"sign_in\" so they can sign in themselves.", app.name)
        };
        let pay = match apps::payment_label(&ctx.core, app.id) {
            Some(p) => format!(" On the checkout page, if \"{p}\" is listed among the user's saved payment methods and isn't selected, select it (selecting is fine; paying is not). If it isn't listed, leave payment alone and mention it."),
            None => String::new(),
        };
        Ok(ToolOutput {
            text: format!(
                "The user confirmed. {} is opening in their browser at {url}. Wait a moment, take a screenshot, then use control_computer to add exactly the confirmed items and go to checkout. Do not press the final Place order, Pay, Request or Reserve button and do not type passwords or card details. Call cart_ready_for_user as soon as the checkout page shows.{pay}{sign_in}",
                app.name
            ),
            summary: format!("Opened {} to fill your cart", app.name),
            data: Some(data),
            ..Default::default()
        })
    }
}

pub struct CartReady;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CartReadyInput {
    /// "checkout" (the cart is ready to place), "sign_in" or "user_choice" (the user must do
    /// something first), or "problem" (Lumo couldn't continue).
    pub stopped_for: String,
    /// One short line for the user: the cart and total exactly as the screen shows them, or what
    /// they need to do.
    pub message: String,
}

#[async_trait]
impl TypedTool for CartReady {
    type Input = CartReadyInput;
    const NAME: &'static str = "cart_ready_for_user";
    const DESCRIPTION: &'static str = "During start_order, hand the screen back at checkout, when the user must sign in or choose, or on a problem. Ends screen control for this task.";
    fn schema(&self) -> Value {
        object_schema(
            json!({
                "stopped_for": {"type": "string", "enum": ["checkout", "sign_in", "user_choice", "problem"]},
                "message": {"type": "string"}
            }),
            &["stopped_for", "message"],
        )
    }
    fn check(&self, ctx: &ToolCtx, i: &CartReadyInput) -> Result<()> {
        if !["checkout", "sign_in", "user_choice", "problem"].contains(&i.stopped_for.as_str()) {
            return Err(invalid("stopped_for must be checkout, sign_in, user_choice or problem"));
        }
        if !ctx.core.pending.orders.lock().contains_key(&ctx.run_id) {
            return Err(invalid("there is no order in progress; use start_order first"));
        }
        Ok(())
    }
    fn risk(&self, _: &ToolCtx, _: &CartReadyInput) -> Risk {
        Risk::Ui
    }
    fn label(&self, _: &CartReadyInput) -> String {
        "Handing the order to you".into()
    }
    async fn run(&self, ctx: &ToolCtx, i: CartReadyInput) -> Result<ToolOutput> {
        let app_id = {
            let mut orders = ctx.core.pending.orders.lock();
            let o = orders.get_mut(&ctx.run_id).ok_or_else(|| invalid("there is no order in progress"))?;
            o.handed_off = true;
            o.app
        };
        end_session(&ctx.core, &ctx.run_id);
        let name = apps::find(app_id).map(|a| a.name).unwrap_or("The app");
        let (title, next) = match i.stopped_for.as_str() {
            "checkout" => (format!("Your {name} cart is ready"), "Check it and place the order yourself when you're happy."),
            "sign_in" => (format!("Sign in to {name}"), "Sign in in your browser, then ask Lumo to carry on."),
            "user_choice" => (format!("{name} needs your choice"), "Pick an option in your browser, then ask Lumo to carry on."),
            _ => (format!("Lumo stopped on {name}"), "Lumo couldn't finish filling the cart. You can finish it in your browser."),
        };
        let _ = ctx.core.platform.notify(&title, next);
        Ok(ToolOutput {
            text: format!(
                "Lumo's control of the mouse and keyboard has ended for this task. Tell the user: {next} Nothing has been ordered by Lumo; do not claim it was. If they want Lumo to continue after signing in or choosing, call start_order again."
            ),
            summary: title,
            data: Some(json!({"app": app_id, "status": i.stopped_for, "message": i.message})),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::ctx;
    use super::super::{execute, Origin, Registry};
    use crate::core::testing::{core_with, set_plan, FakePlatform};
    use crate::core::Screenshot;
    use crate::tools::computer::{looks_like_card_number, session_active};
    use serde_json::json;
    use std::sync::Arc;

    fn shot() -> Screenshot {
        Screenshot { png: vec![1], width: 100, height: 100, origin_x: 0, origin_y: 0, screen_width: 100, screen_height: 100 }
    }

    fn order() -> serde_json::Value {
        json!({"type": "tool_use", "id": "o", "name": "start_order", "input": {
            "app": "ubereats", "search": "Thai Basil", "items": [{"name": "Pad thai", "quantity": 2}]
        }})
    }

    #[tokio::test]
    async fn fills_the_cart_then_hands_it_back_and_never_controls_again() {
        let platform = Arc::new(FakePlatform::default());
        *platform.screen.lock() = Some(shot());
        *platform.confirm.lock() = true;
        let (core, _d) = core_with(platform.clone());
        set_plan(&core, "pro");
        let (ctx, _) = ctx(core.clone(), Origin::User);
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();

        let res = execute(&r, &ctx, &order(), &names).await;
        assert!(res.ok, "{}", res.block);
        assert_eq!(platform.confirms.lock().len(), 1);
        assert!(platform.confirms.lock()[0].title.contains("Uber Eats"));
        assert_eq!(platform.opened.lock().as_slice(), &["https://www.ubereats.com/search?q=Thai+Basil".to_string()]);
        assert!(session_active(&core, &ctx.run_id), "the order's dialog allowed screen control");

        // Filling the cart doesn't ask again.
        core.pending.screens.lock().insert(ctx.run_id.clone(), shot());
        let click = json!({"type": "tool_use", "id": "c", "name": "control_computer", "input": {"reason": "add to cart", "actions": [{"type": "click", "x": 5, "y": 5}]}});
        assert!(execute(&r, &ctx, &click, &names).await.ok);
        assert_eq!(platform.confirms.lock().len(), 1);

        // Card numbers are never typed.
        let card = json!({"type": "tool_use", "id": "k", "name": "control_computer", "input": {"reason": "pay", "actions": [{"type": "type", "text": "4242 4242 4242 4242"}]}});
        let res = execute(&r, &ctx, &card, &names).await;
        assert!(!res.ok && res.block.to_string().contains("never types payment card numbers"));

        let ready = json!({"type": "tool_use", "id": "d", "name": "cart_ready_for_user", "input": {"stopped_for": "checkout", "message": "2 × Pad thai, $31.40"}});
        assert!(execute(&r, &ctx, &ready, &names).await.ok);
        assert!(!session_active(&core, &ctx.run_id));
        assert_eq!(platform.notifications.lock()[0].0, "Your Uber Eats cart is ready");

        // After the handoff, no more screen control in this task, and no dialog is shown for it.
        let n = platform.inputs.lock().len();
        let res = execute(&r, &ctx, &click, &names).await;
        assert!(!res.ok && res.block.to_string().contains("with the user now"));
        assert_eq!(platform.inputs.lock().len(), n);
        assert_eq!(platform.confirms.lock().len(), 1);
    }

    #[tokio::test]
    async fn the_free_plan_gets_the_list_and_the_app() {
        let platform = Arc::new(FakePlatform::default());
        *platform.confirm.lock() = true;
        let (core, _d) = core_with(platform.clone());
        let (ctx, _) = ctx(core.clone(), Origin::User);
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();
        let res = execute(&r, &ctx, &order(), &names).await;
        assert!(res.ok, "{}", res.block);
        assert!(platform.confirms.lock()[0].title.contains("with your order list"));
        assert!(platform.clipboard.lock().contains("2 × Pad thai"));
        assert!(!session_active(&core, &ctx.run_id));
    }

    #[tokio::test]
    async fn declined_unknown_and_background_orders_do_nothing() {
        let platform = Arc::new(FakePlatform::default());
        let (core, _d) = core_with(platform.clone());
        set_plan(&core, "pro");
        let r = Registry::standard();
        let names: Vec<String> = r.names().into_iter().map(String::from).collect();
        let (user, _) = ctx(core.clone(), Origin::User);
        // Declined in the dialog.
        assert!(!execute(&r, &user, &order(), &names).await.ok);
        // Unknown app: refused before any dialog.
        let n = platform.confirms.lock().len();
        let bad = json!({"type": "tool_use", "id": "b", "name": "start_order", "input": {"app": "evil", "items": [{"name": "x", "quantity": 1}]}});
        assert!(!execute(&r, &user, &bad, &names).await.ok);
        assert_eq!(platform.confirms.lock().len(), n);
        // Automations can never order.
        *platform.confirm.lock() = true;
        let (auto, _) = ctx(core.clone(), Origin::Automation);
        let res = execute(&r, &auto, &order(), &names).await;
        assert!(!res.ok && res.needs_attention);
        assert!(platform.opened.lock().is_empty());
        assert!(!session_active(&core, &user.run_id) && !session_active(&core, &auto.run_id));
        // No order in progress: nothing to hand back.
        let ready =
            json!({"type": "tool_use", "id": "d", "name": "cart_ready_for_user", "input": {"stopped_for": "checkout", "message": "x"}});
        assert!(!execute(&r, &user, &ready, &names).await.ok);
    }

    #[test]
    fn card_numbers_are_recognized() {
        assert!(looks_like_card_number("4242 4242 4242 4242"));
        assert!(looks_like_card_number("card 4111-1111-1111-1111 exp"));
        assert!(looks_like_card_number("378282246310005"));
        assert!(!looks_like_card_number("4242 4242 4242 4241"), "fails Luhn");
        assert!(!looks_like_card_number("Order #123456"));
        assert!(!looks_like_card_number("+1 415 555 0100"));
        assert!(!looks_like_card_number("2 pad thai, 1 spring rolls"));
    }
}
