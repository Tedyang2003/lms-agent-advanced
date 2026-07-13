import { tool } from "@lmstudio/sdk";
import { GET_CURRENT_DATETIME_DESCRIPTION } from "../../prompts/shared";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

export function buildDatetimeTool() {
    return tool({
        name: "get_current_datetime",
        description: GET_CURRENT_DATETIME_DESCRIPTION,
        parameters: {},
        implementation: async () => {
            const now = new Date();
            const weekday = WEEKDAYS[now.getDay()];
            const month = MONTHS[now.getMonth()];
            const isoDate = now.toISOString().slice(0, 10);
            const time24h = now.toTimeString().slice(0, 8);

            return (
                `Current date: ${weekday}, ${month} ${now.getDate()}, ${now.getFullYear()} (${isoDate})\n` +
                `Current time: ${time24h}`
            );
        },
    });
}
