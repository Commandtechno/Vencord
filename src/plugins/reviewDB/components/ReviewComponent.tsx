/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { classes, LazyComponent } from "@utils/misc";
import { filters, findBulk } from "@webpack";
import { Alerts, UserStore } from "@webpack/common";

import { Review } from "../entities/Review";
import { deleteReview, reportReview } from "../Utils/ReviewDBAPI";
import { canDeleteReview, openUserProfileModal, showToast } from "../Utils/Utils";
import MessageButton from "./MessageButton";

export default LazyComponent(() => {
    // this is terrible, blame mantika
    const p = filters.byProps;
    const [
        { cozyMessage, buttons, message, groupStart },
        { container, isHeader },
        { avatar, clickable, username, messageContent, wrapper, cozy },
        { contents },
        buttonClasses,
        { defaultColor }
    ] = findBulk(
        p("cozyMessage"),
        p("container", "isHeader"),
        p("avatar", "zalgo"),
        p("contents"),
        p("button", "wrapper", "disabled"),
        p("defaultColor")
    );

    return function ReviewComponent({ review, refetch }: { review: Review; refetch(): void; }) {
        function openModal() {
            openUserProfileModal(review.senderdiscordid);
        }

        function delReview() {
            Alerts.show({
                title: "Are you sure?",
                body: "Do you really want to delete this review?",
                confirmText: "Delete",
                cancelText: "Nevermind",
                onConfirm: () => {
                    deleteReview(review.id).then(res => {
                        if (res.successful) {
                            refetch();
                        }
                        showToast(res.message);
                    });
                }
            });
        }

        function reportRev() {
            Alerts.show({
                title: "Are you sure?",
                body: "Do you really you want to report this review?",
                confirmText: "Report",
                cancelText: "Nevermind",
                // confirmColor: "red", this just adds a class name and breaks the submit button guh
                onConfirm: () => reportReview(review.id)
            });
        }

        return (
            <div className={classes(cozyMessage, message, groupStart, wrapper, cozy, "user-review")}>
                <div className={contents}>
                    <img
                        className={classes(avatar, clickable)}
                        style={{ left: "8px" }}
                        onClick={openModal}
                        src={review.profile_photo || "/assets/1f0bfc0865d324c2587920a7d80c609b.png?size=128"}
                    />
                    <span
                        className={classes(username, clickable)}
                        style={{ color: "var(--text-normal)", right: "8px" }}
                        onClick={() => openModal()}
                    >
                        {review.username}
                    </span>
                    <p
                        className={classes(messageContent, defaultColor)}
                        style={{ fontSize: 15, marginTop: 4, right: "8px" }}
                    >
                        {review.comment}
                    </p>
                    <div className={classes(container, isHeader, buttons)} style={{
                        padding: "0px",
                    }}>
                        <div className={buttonClasses.wrapper} >
                            <MessageButton type="report" callback={reportRev} />
                            {canDeleteReview(review, UserStore.getCurrentUser().id) && (
                                <MessageButton type="delete" callback={delReview} />
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };
});
