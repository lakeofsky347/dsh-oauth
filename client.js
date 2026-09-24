window.__ModuleLoader__.load({
  id: "dsh-oauth",
  factory(require) {
    const React = require("react");
    function OAuthSection() {
      return React.createElement("iframe", {
        src: "/oauth/",
        title: "OAuth",
        style: {
          width: "100%",
          height: "calc(100vh - 120px)",
          minHeight: "640px",
          border: 0,
          background: "#151517",
          borderRadius: "12px",
        },
      });
    }
    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "oauth",
          order: 40,
          label: "OAuth",
        }, OAuthSection));
      },
    };
  },
});
